//! Starts the real binary on a temp vault and speaks MCP to it over stdin/stdout,
//! one JSON-RPC message per line.

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Client {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").unwrap();
    }

    /// Sends a request and returns the response with the same id.
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let mut line = String::new();
            let read = self.stdout.read_line(&mut line).unwrap();
            assert!(read > 0, "server closed stdout before answering {method}");
            // Every stdout line must be protocol JSON.
            let message: Value = serde_json::from_str(&line).expect("stdout line is not JSON");
            if message["id"] == id {
                return message;
            }
        }
    }

    /// Calls a tool and returns `(is_error, text of the first content block)`.
    fn tool(&mut self, name: &str, arguments: Value) -> (bool, String) {
        let response = self.request("tools/call", json!({ "name": name, "arguments": arguments }));
        let result = &response["result"];
        let text = result["content"][0]["text"].as_str().unwrap_or_else(|| panic!("no text in {response}"));
        (result["isError"] == true, text.to_string())
    }
}

#[test]
fn serves_a_vault_over_stdio() {
    let dir = tempfile::tempdir().unwrap();
    // Where `health` looks up the repositories that notes name by folder name.
    let roots = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_inklode-mcp"))
        .arg("--vault")
        .arg(dir.path())
        .env("VAULT_REPO_ROOTS", format!("/no/such/root:{}", roots.path().display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut client = Client {
        stdin: child.stdin.take().unwrap(),
        stdout: BufReader::new(child.stdout.take().unwrap()),
        next_id: 0,
    };

    let init = client.request(
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0" },
        }),
    );
    assert!(init["result"]["capabilities"]["tools"].is_object(), "{init}");
    client.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    let listed = client.request("tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        ["search", "read", "write", "create", "rename", "delete", "folder_rename", "folder_delete", "folder_new", "list", "backlinks", "resolve", "git_log", "git_show", "git_blame", "review_list", "health", "tasks", "claims_list"]
    );
    let write = &tools[2];
    assert!(!write["description"].as_str().unwrap().is_empty());
    // `base` is offered and optional.
    assert_eq!(write["inputSchema"]["required"], json!(["path", "content"]));
    assert!(write["inputSchema"]["properties"]["base"]["description"].is_string());
    assert!(write["inputSchema"]["properties"]["path"]["description"].is_string());
    assert_eq!(tools[3]["inputSchema"]["required"], json!(["path"]));

    let (is_error, text) = client.tool("write", json!({ "path": "sub/a.md", "content": "a zebra\n" }));
    assert_eq!((is_error, text.as_str()), (false, "null"));
    assert_eq!(std::fs::read_to_string(dir.path().join("sub/a.md")).unwrap(), "a zebra\n");

    // `create` never replaces a file, and a `write` with a stale `base` writes nothing.
    let (is_error, text) = client.tool("create", json!({ "path": "sub/a.md" }));
    assert_eq!((is_error, text.as_str()), (true, "already exists: sub/a.md"));
    let (is_error, text) = client.tool("create", json!({ "path": "made/b.md", "content": "b" }));
    assert_eq!((is_error, text.as_str()), (false, "null"));
    let (is_error, text) = client.tool("write", json!({ "path": "made/b.md", "content": "c", "base": "not b" }));
    assert_eq!((is_error, text.as_str()), (true, "changed on disk since it was read: made/b.md"));
    let (is_error, _) = client.tool("write", json!({ "path": "made/b.md", "content": "c", "base": "b" }));
    assert!(!is_error);
    assert_eq!(std::fs::read_to_string(dir.path().join("made/b.md")).unwrap(), "c");
    // A file wrongly spelled in `from` still has its links rewritten (on a disk that ignores case).
    #[cfg(target_os = "macos")]
    {
        client.tool("write", json!({ "path": "made/links.md", "content": "[[made/b]]" }));
        let (_, text) = client.tool("rename", json!({ "from": "MADE/B.md", "to": "made/d.md" }));
        assert_eq!(text, r#"{"updated":["made/links.md"]}"#);
        client.tool("rename", json!({ "from": "made/d.md", "to": "made/b.md" }));
    }

    // Nothing under a dot name is reached through a note path.
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();
    std::fs::write(dir.path().join(".git/config"), "[core]").unwrap();
    for (tool, arguments) in [
        ("read", json!({ "path": ".git/config" })),
        ("write", json!({ "path": ".inklode/settings.json", "content": "{}" })),
        ("create", json!({ "path": ".git/hooks/pre-commit" })),
        ("delete", json!({ "path": ".git/config" })),
        ("rename", json!({ "from": ".git/config", "to": "config.md" })),
        ("rename", json!({ "from": "sub/a.md", "to": ".git/hooks/pre-commit" })),
    ] {
        let (is_error, text) = client.tool(tool, arguments);
        assert!(is_error && text.starts_with("path is outside the vault or has a part that starts with a dot"), "{tool}: {text}");
    }
    assert_eq!(std::fs::read_to_string(dir.path().join(".git/config")).unwrap(), "[core]");
    assert_eq!(std::fs::read_dir(dir.path().join(".git")).unwrap().count(), 1);
    assert!(!dir.path().join(".trash").exists() && !dir.path().join(".inklode").exists());

    let (is_error, text) = client.tool("read", json!({ "path": "sub/a.md" }));
    assert!(!is_error);
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({ "content": "a zebra\n" }));

    let (is_error, text) = client.tool("search", json!({ "query": "ZEBRA" }));
    assert!(!is_error);
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!([{ "path": "sub/a.md", "line": 1, "text": "a zebra" }])
    );

    let (is_error, text) = client.tool("list", json!({}));
    assert!(!is_error);
    assert!(text.contains("sub/a.md"), "{text}");

    let (is_error, text) = client.tool("tasks", json!({}));
    assert_eq!((is_error, text.as_str()), (false, "[]"));
    client.tool("write", json!({ "path": "todo.md", "content": "- [ ] call back\n- [x] done\n[[nowhere]]\n" }));
    let (_, text) = client.tool("tasks", json!({}));
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!([{ "path": "todo.md", "tasks": [{ "line": 1, "text": "call back" }] }]));
    // A claim is listed with what its last check found, if the user ran one in the app: this server runs none.
    client.tool("write", json!({ "path": "claim.md", "content": "Here. <!-- check: file todo.md -->\n" }));
    let (is_error, text) = client.tool("claims_list", json!({}));
    assert!(!is_error, "{text}");
    let claims: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((&claims[0]["path"], &claims[0]["line"], &claims[0]["text"], &claims[0]["evidence"], &claims[0]["kind"]), (&json!("claim.md"), &json!(1), &json!("Here."), &json!("file todo.md"), &json!("file")));
    assert_eq!(claims.as_array().unwrap().len(), 1);
    client.tool("delete", json!({ "path": "claim.md" }));
    let (is_error, text) = client.tool("health", json!({}));
    assert!(!is_error);
    let health: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(health["broken"], json!([{ "path": "todo.md", "links": [{ "line": 3, "link": "nowhere", "text": "[[nowhere]]" }] }]));
    assert_eq!((&health["stale"], &health["unchecked"]), (&json!([]), &json!([])));

    // A note is stale against a repository found by its folder name under `$VAULT_REPO_ROOTS`, two levels down.
    let repo = roots.path().join("group/the-app");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(repo.join("a.txt"), "a").unwrap();
    let git = |args: &[&str]| {
        let config = ["-c", "user.name=Ana", "-c", "user.email=ana@example.com", "-c", "commit.gpgsign=false"];
        Command::new("git").current_dir(&repo).args(config).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").output().is_ok_and(|out| out.status.success())
    };
    if git(&["init", "-q"]) && git(&["add", "-A"]) && git(&["commit", "-q", "-m", "first"]) {
        client.tool("write", json!({ "path": "app.md", "content": "---\nrepos: [the-app, not-there]\nupdated: 2020-01-01\n---\n" }));
        let (_, text) = client.tool("health", json!({}));
        let health: Value = serde_json::from_str(&text).unwrap();
        let stale = &health["stale"][0];
        assert_eq!((&stale["path"], &stale["repo"], &stale["commits"], &stale["newest"]["subject"]), (&json!("app.md"), &json!("the-app"), &json!(1), &json!("first")), "{health}");
        assert_eq!(health["unchecked"], json!([{ "path": "app.md", "repo": "not-there", "reason": "not found or not a git repository" }]));
    }

    // A core error is a tool error that carries the core's message.
    let (is_error, text) = client.tool("read", json!({ "path": "missing.md" }));
    assert!(is_error);
    assert!(text.contains("missing.md"), "{text}");

    // Missing arguments are a tool error too, not a crash.
    let (is_error, text) = client.tool("read", json!({}));
    assert!(is_error);
    assert!(text.contains("bad params"), "{text}");

    let unknown = client.request("tools/call", json!({ "name": "nope", "arguments": {} }));
    assert!(unknown["error"]["message"].as_str().unwrap().contains("unknown tool"), "{unknown}");

    // Closing stdin ends the server.
    drop(client);
    assert!(child.wait().unwrap().success());
}
