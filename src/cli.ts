#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createClassDojoServer } from "./server.js";

const server = createClassDojoServer();
await server.connect(new StdioServerTransport());
