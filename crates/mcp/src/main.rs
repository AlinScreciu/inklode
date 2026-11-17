//! `inklode-mcp --vault <absolute folder>`: serves one vault as MCP tools over stdio.
//!
//! stdout carries only MCP protocol messages. Anything for a human goes to stderr.

use std::process::ExitCode;
use std::sync::Mutex;

use inklode_core::Core;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
    ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde_json::{Value, json};

struct Server {
    // shortcut: a call blocks the async runtime while it runs, fine for the one
    // client stdio has. The app's HTTP server uses `spawn_blocking` instead.
    core: Mutex<Core>,
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Tools over one Inklode vault, a folder of Markdown notes. Paths are relative to the vault root and use forward slashes.",
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(inklode_mcp::tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let params = Value::Object(request.arguments.unwrap_or_default());
        match inklode_mcp::call(&self.core, &request.name, params) {
            Some(result) => Ok(result.into()),
            None => Err(ErrorData::invalid_params(format!("unknown tool: {}", request.name), None)),
        }
    }
}

/// The desktop app's config folder, where it keeps its settings.json and what the user has
/// reviewed, so this server and the app agree on the review inbox.
// shortcut: the app's identifier and the folder rules of Tauri's `app_config_dir` are repeated
// here; share them through a crate both depend on if the identifier ever changes
fn state_dir() -> Option<std::path::PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(std::path::PathBuf::from);
    let config = if cfg!(target_os = "macos") {
        var("HOME")?.join("Library/Application Support")
    } else if cfg!(windows) {
        var("APPDATA")?
    } else {
        var("XDG_CONFIG_HOME").or_else(|| Some(var("HOME")?.join(".config")))?
    };
    Some(config.join("app.inklode.desktop"))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [flag, vault] = args.as_slice() else {
        eprintln!("usage: inklode-mcp --vault <absolute folder>");
        return ExitCode::from(2);
    };
    if flag != "--vault" {
        eprintln!("usage: inklode-mcp --vault <absolute folder>");
        return ExitCode::from(2);
    }

    let mut core = Core::new();
    match state_dir() {
        Some(dir) => core.set_state_dir(dir),
        None => eprintln!("inklode-mcp: no home folder, so review_list and claims_list are not available"),
    }
    if let Err(error) = core.call("vault.open", json!({ "path": vault })) {
        eprintln!("inklode-mcp: {error}");
        return ExitCode::FAILURE;
    }

    let server = Server { core: Mutex::new(core) };
    let running = match server.serve(rmcp::transport::stdio()).await {
        Ok(running) => running,
        Err(error) => {
            eprintln!("inklode-mcp: {error}");
            return ExitCode::FAILURE;
        }
    };
    // Runs until the client closes stdin.
    if let Err(error) = running.waiting().await {
        eprintln!("inklode-mcp: {error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
