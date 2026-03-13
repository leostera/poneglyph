use anyhow::Result;
use poneglyph::{Poneglyph, Workspace};

use crate::cli::RunArgs;

/// Long-lived daemon host for a configured [`Poneglyph`] runtime.
pub struct Daemon {
    _poneglyph: Poneglyph,
}

impl Daemon {
    pub async fn open(args: RunArgs) -> Result<Self> {
        let mut builder = Poneglyph::builder();
        if let Some(workspace) = args.workspace {
            builder = builder.with_workspace(Workspace::at(workspace));
        }

        let poneglyph = builder.build().await?;
        Ok(Self {
            _poneglyph: poneglyph,
        })
    }

    #[cfg(test)]
    pub fn poneglyph(&self) -> &Poneglyph {
        &self._poneglyph
    }

    pub async fn run(self) -> Result<()> {
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::Daemon;
    use crate::cli::RunArgs;

    #[tokio::test]
    async fn daemon_open_uses_custom_workspace() {
        let tempdir = tempdir().expect("tempdir");
        let args = RunArgs {
            workspace: Some(tempdir.path().to_path_buf()),
        };

        let daemon = Daemon::open(args).await.expect("daemon");

        assert_eq!(daemon.poneglyph().workspace().root(), tempdir.path());
        assert!(daemon.poneglyph().workspace().store_dir().exists());
    }
}
