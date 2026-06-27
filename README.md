# FreshRSS MCP Server

A Model Context Protocol server for interacting with FreshRSS feeds via the
**Google Reader compatible API** (`/api/greader.php`).

This TypeScript-based MCP server allows AI assistants to interact with your
FreshRSS instance, enabling them to:

- List and browse your RSS feeds
- Fetch unread items
- Mark items as read/unread
- Get items from specific feeds

## Works with OIDC-protected FreshRSS

FreshRSS supports [OpenID Connect (OIDC)](https://freshrss.github.io/FreshRSS/en/admins/16_OpenID-Connect.html)
for logging in to the **web interface**. When OIDC is enabled, the web UI
(under `/i/`) is gated by your identity provider, but the **API endpoints**
(under `/api/`) are deliberately left outside the OIDC realm and authenticate
with a separate per-user **API password**.

This server uses the Google Reader API, which authenticates purely with that API
password — so it works the same whether or not OIDC is enabled. (The original
version of this project used the older Fever API; the Google Reader API is the
modern, recommended path and is documented by FreshRSS as the more powerful of
the two.)

> **Note:** This relies on FreshRSS keeping its `/api/` paths outside the OIDC
> realm, which is the behaviour of the official Docker image / reference Apache
> config. If you have manually placed `/api/` behind your identity provider,
> the API password alone will not be sufficient.

### Setting up the API password

1. In FreshRSS, go to **Settings → Authentication** and enable
   *"Allow API access (required for mobile apps)"*.
2. Go to **Settings → Profile** and set an **API password**. This is separate
   from your normal (or OIDC) login password.
3. Use your FreshRSS **username** and this **API password** with this server.

You can verify it manually with cURL:

```sh
curl -X POST -d 'Email=YOUR_USERNAME&Passwd=YOUR_API_PASSWORD' \
  'https://your-freshrss-instance.com/api/greader.php/accounts/ClientLogin'
# Should print SID=... / Auth=... lines.
```

## Features

### Tools

- `list_feeds` - List all feed subscriptions
- `get_feed_groups` - Get feed groups (tags/folders)
- `get_unread` - Get unread items (optional `limit`)
- `get_feed_items` - Get items from a specific feed (optional `limit`)
- `mark_item_read` - Mark an item as read
- `mark_item_unread` - Mark an item as unread
- `mark_feed_read` - Mark all items in a feed as read
- `get_items` - Get specific items by their IDs

Feed IDs may be given either as plain numbers (`3`) or in Google Reader form
(`feed/3`).

## Requirements

- A running FreshRSS instance with API access enabled
- The instance URL, your username, and your **API password**

## Development

Install dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

For development with auto-rebuild:
```bash
npm run watch
```

### Environment Variables

You need to set the following environment variables:

- `FRESHRSS_API_URL`: Base URL of your FreshRSS instance (e.g.
  `https://rss.example.com`). Do **not** include `/api/greader.php`; the server
  appends it.
- `FRESHRSS_USERNAME`: Your FreshRSS username.
- `FRESHRSS_API_PASSWORD`: Your FreshRSS **API password** (Profile → "API
  password"). For backwards compatibility, `FRESHRSS_PASSWORD` is also accepted
  — but it must be the API password, not your OIDC/web login password.

## Installation

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "node",
      "args": ["/path/to/freshrss-server/build/index.js"],
      "env": {
        "FRESHRSS_API_URL": "https://your-freshrss-instance.com",
        "FRESHRSS_USERNAME": "your-username",
        "FRESHRSS_API_PASSWORD": "your-api-password"
      }
    }
  }
}
```

For Cline MCP integration, add to your MCP settings:

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "node",
      "args": ["/path/to/freshrss-server/build/index.js"],
      "env": {
        "FRESHRSS_API_URL": "https://your-freshrss-instance.com",
        "FRESHRSS_USERNAME": "your-username",
        "FRESHRSS_API_PASSWORD": "your-api-password"
      }
    }
  }
}
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We
recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector),
which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.

## Security Note

This server requires your FreshRSS API credentials. For security:
- Never commit your credentials to version control
- Always use environment variables for sensitive information
- Consider using a dedicated FreshRSS account with appropriate permissions

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Credits

Based on [rakeshgangwar/freshrss-mcp-server](https://github.com/rakeshgangwar/freshrss-mcp-server),
migrated from the Fever API to the Google Reader API for OIDC compatibility.
