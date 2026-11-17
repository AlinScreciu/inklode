//! Inklode core: everything that touches the vault on disk.
//!
//! The UI and the MCP server both go through [`Core::call`], so there is one
//! list of operations and one place where they are implemented.

mod call;
mod claims;
mod git;
mod health;
mod index;
mod review;
mod vault;
mod watch;

pub use call::{ClaimCheck, Core};
pub use vault::{Entry, Vault};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("not a folder: {0}")]
    NotAFolder(String),
    #[error("path is outside the vault or has a part that starts with a dot: {0}")]
    BadPath(String),
    /// A path that a symbolic link in the vault takes out of the vault, or to a dot name.
    #[error("a symbolic link takes this path out of the vault, or to a name that starts with a dot: {0}")]
    Outside(String),
    /// `note.write` with a `base` that the file on disk no longer matches.
    #[error("changed on disk since it was read: {0}")]
    Conflict(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    Exists(String),
    #[error("cannot move {0} to {1}")]
    BadMove(String, String),
    /// A rename to a name that no `[[link]]` can say: the name, and what is wrong with it.
    #[error("cannot rename to \"{0}\": a name cannot {1}")]
    BadName(String, String),
    /// A move after which no link Obsidian can read would keep a link on its note.
    #[error("a link in {0} to {1} would point to another note of that name after this move; rename one of the two notes first")]
    LinkLost(String, String),
    #[error("no vault is open")]
    NoVault,
    /// A `review.*` or `claims.*` operation on a core that was not given a folder for its state.
    #[error("review and claims need a state folder, and this core has none")]
    NoStateFolder,
    /// `claims.check` of a line that has no claim: the path and the line.
    #[error("no claim on line {1} of {0}")]
    NoClaim(String, usize),
    /// `claims.check` of a claim whose evidence is a command, without `commands`.
    #[error("commands are not allowed for this vault")]
    CommandsRefused,
    #[error("unknown call: {0}")]
    UnknownCall(String),
    #[error("bad params for {0}: {1}")]
    BadParams(String, String),
}
