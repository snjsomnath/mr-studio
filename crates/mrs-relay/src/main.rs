//! `mrs-relay`: the phone relay (#89). Run it on a server with a public address, behind
//! HTTPS (Caddy, nginx or a cloud load balancer), and give each studio computer a token.
//!
//! ```text
//! MRS_RELAY_TOKENS=token-for-the-studio,token-for-lindholmen mrs-relay --bind 0.0.0.0:8080
//! ```

use std::net::SocketAddr;

use clap::Parser;

#[derive(Parser)]
#[command(about = "MR Studio phone relay: phones join a table from any network")]
struct Args {
    #[arg(long, default_value = "0.0.0.0:8080")]
    bind: SocketAddr,
    /// Allow the room cookie over plain HTTP. Only for trying the relay on one computer.
    #[arg(long)]
    insecure_cookies: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    let args = Args::parse();
    // Tokens that let a studio computer open a room, separated by commas. From the
    // environment, so they stay out of the process list.
    let tokens = std::env::var("MRS_RELAY_TOKENS").unwrap_or_default();
    let tokens: Vec<String> = tokens.split(',').map(|t| t.trim().to_string()).filter(|t| t.len() >= 16).collect();
    anyhow::ensure!(!tokens.is_empty(), "give at least one token of 16 characters or more in MRS_RELAY_TOKENS");
    let relay = mrs_relay::Relay::new(mrs_relay::Config { tokens, secure_cookies: !args.insecure_cookies });
    mrs_relay::serve(relay, args.bind).await
}
