#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import { resolve } from "path";
import { getServerConfig } from "./config.js";//Custom helper that reads figmaApiKey and port from CLI or .env.
import { startHttpServer } from "./server.js";
import { createServer } from "./mcp.js";

// Load .env from the current working directory
config({ path: resolve(process.cwd(), ".env") });

export async function startServer(): Promise<void> {
  // Check if we're running in stdio mode (e.g., via CLI)
  //process.argv is an array. It contains all arguments passed to the script — including Node itself and the file name.
  const isStdioMode = process.env.NODE_ENV === "cli" || process.argv.includes("--stdio");

  const config = getServerConfig(isStdioMode);
  //Below shows the return type of getServerConfig
  // const config =  {
  //   figmaApiKey: string;
  //   port: number;
  //   configSources: {
  //     figmaApiKey: "cli" | "env";
  //     port: "cli" | "env" | "default";
  //   };

  const server = createServer(config.figmaApiKey, { isHTTP: !isStdioMode });

  if (isStdioMode) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    console.log(`Initializing Figma MCP Server in HTTP mode on port ${config.port}...`);
    await startHttpServer(config.port, server);
  }
}

// If we're being executed directly (not imported), start the server
if (process.argv[1]) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
