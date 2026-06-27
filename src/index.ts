#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosError, AxiosRequestConfig } from "axios";

// GReader state constants
const STATE_READ = "user/-/state/com.google/read";

/**
 * Client for the FreshRSS Google Reader compatible API (`/api/greader.php`).
 *
 * Why GReader instead of the Fever API? On FreshRSS instances protected by
 * OpenID Connect (OIDC), the web UI lives under `/i/` and is gated by the IdP,
 * while the API endpoints under `/api/` are deliberately left outside the OIDC
 * realm and authenticate with the per-user "API password" instead. The GReader
 * API is the modern, recommended path (the Fever API is documented as "less
 * powerful") and works unchanged whether or not OIDC is enabled, because it
 * never touches the OIDC-protected web session — it only uses the API password.
 *
 * Auth flow:
 *   1. POST /accounts/ClientLogin with Email + Passwd (the API password) to get
 *      an `Auth` token.
 *   2. Send `Authorization: GoogleLogin auth=<token>` on every request.
 *   3. For write actions (edit-tag, mark-all-as-read) fetch a short-lived write
 *      token `T` from /reader/api/0/token and include it in the POST body.
 */
class FreshRSSClient {
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly username: string;
  private readonly password: string;

  private authToken: string | null = null;
  private writeToken: string | null = null;

  constructor(apiUrl: string, username: string, password: string) {
    this.baseUrl = apiUrl.replace(/\/+$/, "");
    this.endpoint = `${this.baseUrl}/api/greader.php`;
    this.username = username;
    this.password = password;
  }

  /** Authenticate via ClientLogin and cache the `Auth` token. */
  private async login(): Promise<string> {
    try {
      const response = await axios.post(
        `${this.endpoint}/accounts/ClientLogin`,
        new URLSearchParams({ Email: this.username, Passwd: this.password }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          responseType: "text",
          // ClientLogin returns 200 with the token, anything else is a failure.
        },
      );

      const body = String(response.data);
      const match = body.match(/Auth=(.+)/);
      if (!match) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "FreshRSS ClientLogin did not return an Auth token. Check the username " +
            "and that FRESHRSS_PASSWORD is the API password set in your FreshRSS " +
            "profile (not your OIDC/web login password).",
        );
      }
      this.authToken = match[1].trim();
      return this.authToken;
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw this.toMcpError(error, "ClientLogin failed");
    }
  }

  private async ensureAuth(): Promise<void> {
    if (!this.authToken) {
      await this.login();
    }
  }

  /** Fetch (and cache) the write token `T` required for modifying actions. */
  private async ensureWriteToken(): Promise<string> {
    if (this.writeToken) {
      return this.writeToken;
    }
    const token = await this.request<string>("GET", "reader/api/0/token", {
      responseType: "text",
    });
    this.writeToken = String(token).trim();
    return this.writeToken;
  }

  /**
   * Perform an authenticated request, transparently re-authenticating once if
   * the cached token has expired (FreshRSS replies 401 in that case).
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    config: AxiosRequestConfig = {},
  ): Promise<T> {
    await this.ensureAuth();

    const send = () =>
      axios.request<T>({
        method,
        url: `${this.endpoint}/${path}`,
        ...config,
        headers: {
          Authorization: `GoogleLogin auth=${this.authToken}`,
          ...(config.headers ?? {}),
        },
      });

    try {
      return (await send()).data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        // Token likely expired — drop cached state and retry once.
        this.authToken = null;
        this.writeToken = null;
        await this.ensureAuth();
        try {
          return (await send()).data;
        } catch (retryError) {
          throw this.toMcpError(retryError, "FreshRSS API error");
        }
      }
      throw this.toMcpError(error, "FreshRSS API error");
    }
  }

  private toMcpError(error: unknown, prefix: string): McpError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: string }>;
      const detail =
        axiosError.response?.data?.error ||
        (typeof axiosError.response?.data === "string"
          ? axiosError.response.data
          : undefined) ||
        axiosError.message;
      const status = axiosError.response?.status;
      return new McpError(
        ErrorCode.InternalError,
        `${prefix}: ${status ? `HTTP ${status}: ` : ""}${detail}`,
      );
    }
    return new McpError(ErrorCode.InternalError, `${prefix}: ${String(error)}`);
  }

  /** Normalise a feed id ("feed/3" or "3") to its numeric form. */
  private static numericFeedId(feedId: number | string): string {
    return String(feedId).replace(/^feed\//, "");
  }

  // --- Read operations ------------------------------------------------------

  /** List all feed subscriptions. */
  async getSubscriptions(): Promise<unknown> {
    return this.request("GET", "reader/api/0/subscription/list", {
      params: { output: "json" },
    });
  }

  /** List tags / folders (the GReader equivalent of feed groups). */
  async getFeedGroups(): Promise<unknown> {
    return this.request("GET", "reader/api/0/tag/list", {
      params: { output: "json" },
    });
  }

  /** Get unread items from the reading list. */
  async getUnreadItems(limit = 50): Promise<unknown> {
    return this.request("GET", "reader/api/0/stream/contents/reading-list", {
      params: {
        output: "json",
        n: limit,
        xt: STATE_READ, // exclude already-read items
      },
    });
  }

  /** Get items from a specific feed. */
  async getFeedItems(feedId: number | string, limit = 50): Promise<unknown> {
    const id = FreshRSSClient.numericFeedId(feedId);
    return this.request(
      "GET",
      `reader/api/0/stream/contents/feed/${encodeURIComponent(id)}`,
      { params: { output: "json", n: limit } },
    );
  }

  /** Get specific items by their IDs. */
  async getItems(itemIds: string[]): Promise<unknown> {
    const params = new URLSearchParams({ output: "json" });
    for (const id of itemIds) {
      params.append("i", id);
    }
    return this.request("POST", "reader/api/0/stream/items/contents", {
      data: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  // --- Write operations -----------------------------------------------------

  private async editTag(
    itemId: string,
    tag: string,
    action: "add" | "remove",
  ): Promise<void> {
    const token = await this.ensureWriteToken();
    const params = new URLSearchParams({ T: token, i: itemId });
    params.append(action === "add" ? "a" : "r", tag);
    await this.request("POST", "reader/api/0/edit-tag", {
      data: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  /** Mark an item as read. */
  async markAsRead(itemId: string): Promise<void> {
    await this.editTag(itemId, STATE_READ, "add");
  }

  /** Mark an item as unread. */
  async markAsUnread(itemId: string): Promise<void> {
    await this.editTag(itemId, STATE_READ, "remove");
  }

  /** Mark all items in a feed as read. */
  async markFeedAsRead(feedId: string): Promise<void> {
    const token = await this.ensureWriteToken();
    const id = FreshRSSClient.numericFeedId(feedId);
    const params = new URLSearchParams({
      T: token,
      s: `feed/${id}`,
      ts: `${Date.now()}000`, // microseconds: mark everything older than "now"
    });
    await this.request("POST", "reader/api/0/mark-all-as-read", {
      data: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }
}

// Initialize server
const apiUrl = process.env.FRESHRSS_API_URL;
const username = process.env.FRESHRSS_USERNAME;
// FRESHRSS_API_PASSWORD is preferred for clarity; FRESHRSS_PASSWORD is kept for
// backwards compatibility. Either way this must be the FreshRSS *API password*
// (Profile -> "API password"), which works regardless of OIDC web login.
const password = process.env.FRESHRSS_API_PASSWORD || process.env.FRESHRSS_PASSWORD;

if (!apiUrl || !username || !password) {
  throw new Error(
    "FRESHRSS_API_URL, FRESHRSS_USERNAME, and FRESHRSS_API_PASSWORD (or " +
      "FRESHRSS_PASSWORD) environment variables are required",
  );
}

const client = new FreshRSSClient(apiUrl, username, password);

const server = new Server(
  {
    name: "freshrss-server",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_feeds",
      description: "List all feed subscriptions",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_feed_groups",
      description: "Get feed groups (tags/folders)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_unread",
      description: "Get unread items",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of items to return (default 50)",
          },
        },
      },
    },
    {
      name: "get_feed_items",
      description: "Get items from a specific feed",
      inputSchema: {
        type: "object",
        properties: {
          feed_id: {
            type: "string",
            description: "Feed ID (e.g. \"3\" or \"feed/3\")",
          },
          limit: {
            type: "number",
            description: "Maximum number of items to return (default 50)",
          },
        },
        required: ["feed_id"],
      },
    },
    {
      name: "mark_item_read",
      description: "Mark an item as read",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Item ID to mark as read",
          },
        },
        required: ["item_id"],
      },
    },
    {
      name: "mark_item_unread",
      description: "Mark an item as unread",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Item ID to mark as unread",
          },
        },
        required: ["item_id"],
      },
    },
    {
      name: "mark_feed_read",
      description: "Mark all items in a feed as read",
      inputSchema: {
        type: "object",
        properties: {
          feed_id: {
            type: "string",
            description: "Feed ID to mark as read (e.g. \"3\" or \"feed/3\")",
          },
        },
        required: ["feed_id"],
      },
    },
    {
      name: "get_items",
      description: "Get specific items by their IDs",
      inputSchema: {
        type: "object",
        properties: {
          item_ids: {
            type: "array",
            items: {
              type: "string",
            },
            description: "Array of item IDs to get",
          },
        },
        required: ["item_ids"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "list_feeds": {
        const response = await client.getSubscriptions();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "get_feed_groups": {
        const response = await client.getFeedGroups();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "get_unread": {
        const { limit } = (request.params.arguments ?? {}) as { limit?: number };
        const response = await client.getUnreadItems(limit);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "get_feed_items": {
        const { feed_id, limit } = request.params.arguments as {
          feed_id: string;
          limit?: number;
        };
        const response = await client.getFeedItems(feed_id, limit);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }

      case "mark_item_read": {
        const { item_id } = request.params.arguments as { item_id: string };
        await client.markAsRead(item_id);
        return {
          content: [{
            type: "text",
            text: `Successfully marked item ${item_id} as read`,
          }],
        };
      }

      case "mark_item_unread": {
        const { item_id } = request.params.arguments as { item_id: string };
        await client.markAsUnread(item_id);
        return {
          content: [{
            type: "text",
            text: `Successfully marked item ${item_id} as unread`,
          }],
        };
      }

      case "mark_feed_read": {
        const { feed_id } = request.params.arguments as { feed_id: string };
        await client.markFeedAsRead(feed_id);
        return {
          content: [{
            type: "text",
            text: `Successfully marked all items in feed ${feed_id} as read`,
          }],
        };
      }

      case "get_items": {
        const { item_ids } = request.params.arguments as { item_ids: string[] };
        const items = await client.getItems(item_ids);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(items, null, 2),
          }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, String(error));
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('FreshRSS MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
