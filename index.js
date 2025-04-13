#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import transit from 'transit-js';
import fetch from 'node-fetch';

class ShadowCLJSMonitor {
  constructor() {
    this.lastBuildStatus = null;
    this.writer = transit.writer('json');
    this.reader = transit.reader('json');
  }

  transitMapToObject(map) {
    const obj = {};
    if (map && typeof map.get === 'function') {
      for (let key of map.keys()) {
        const rawKey = key.toString();
        const val = map.get(key);
        obj[rawKey] = val && val.toString ? val.toString() : val;
      }
    }
    return obj;
  }

  getLastBuildStatus() {
    return this.lastBuildStatus || {
      status: 'unknown',
      message: 'No build status available yet',
      timestamp: new Date().toISOString()
    };
  }

  async getServerToken() {
    while (true) {
      const ports = [9630];
      
      for (const port of ports) {
        try {
          console.log(`Trying to connect to shadow-cljs on port ${port}...`);
          const response = await fetch(`http://localhost:${port}`);
          const html = await response.text();
          
          const tokenMatch = html.match(/<meta\s+content="([^"]+)"\s+name="shadow-remote-token"/);
          if (tokenMatch && tokenMatch[1]) {
            console.log(`Successfully connected to port ${port}`);
            return { token: tokenMatch[1], port };
          }
        } catch (err) {
          console.log(`Could not connect to port ${port}: ${err.message}`);
        }
      }
      console.log('Could not connect to shadow-cljs server, retrying in 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async initWebSocket() {
    const { token, port } = await this.getServerToken();
    const ws = new WebSocket(`ws://localhost:${port}/api/remote-relay?id=shadow-cljs-monitor&server-token=${token}`);
    
    ws.on('open', () => {
      const helloMsg = transit.map([
        transit.keyword('op'), transit.keyword('hello'),
        transit.keyword('client-info'), transit.map([
          transit.keyword('type'), transit.keyword('shadow-cljs-ui')
        ])
      ]);
      ws.send(this.writer.write(helloMsg));
      
      const dbSyncMsg = transit.map([
        transit.keyword('op'), transit.keyword('shadow.cljs/db-sync-init!'),
        transit.keyword('to'), 1
      ]);
      ws.send(this.writer.write(dbSyncMsg));
    });

    ws.on('message', (data) => {
      try {
        const decoded = this.reader.read(data);
        if (!decoded) return;
        
        const msg = this.transitMapToObject(decoded);
        if (!msg) return;

        if (msg[':op'] === ':shadow.cljs/db-update') {
          const changes = msg[':changes'];
          if (changes && typeof changes === 'string') {
            if (changes.includes(':status => :failed')) {
              this.lastBuildStatus = {
                status: 'failed',
                message: 'Build failed',
                details: msg,
                timestamp: new Date().toISOString()
              };
            } else if (changes.includes(':status => :completed')) {
              const resourcesMatch = changes.match(/:resources => (\d+)/);
              const compiledMatch = changes.match(/:compiled => (\d+)/);
              const warningsMatch = changes.match(/:warnings => \[([^\]]*)\]/);
              const durationMatch = changes.match(/:duration => ([\d.]+)/);

              if (resourcesMatch && compiledMatch && warningsMatch && durationMatch) {
                this.lastBuildStatus = {
                  status: 'completed',
                  resources: parseInt(resourcesMatch[1]),
                  compiled: parseInt(compiledMatch[1]),
                  warnings: warningsMatch[1].length ? warningsMatch[1].split(',').length : 0,
                  duration: parseFloat(durationMatch[1]),
                  timestamp: new Date().toISOString()
                };
              }
            }
          }
        }

        if (msg[':op'] === ':ping') {
          const pongMsg = transit.map([transit.keyword('op'), transit.keyword('pong')]);
          ws.send(this.writer.write(pongMsg));
        }
      } catch (err) {
        console.error('Error processing message:', err);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });

    ws.on('close', () => {
      setTimeout(() => this.initWebSocket(), 2000);
    });
  }
}

class ShadowCLJSServer {
  constructor() {
    this.monitor = new ShadowCLJSMonitor();
    this.server = new Server(
      {
        name: "shadow-cljs-mcp",
        version: "0.1.0"
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_last_build_status",
          description: "Get the status of the last shadow-cljs build including any warnings or errors. Call this after making edits to ClojureScript files to verify if the build succeeded or failed.",
          inputSchema: {
            type: "object",
            properties: {},
            required: []
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!request.params || request.params.name !== "get_last_build_status") {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params?.name || 'undefined'}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(this.monitor.getLastBuildStatus(), null, 2)
          }
        ]
      };
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.monitor.initWebSocket();
    await this.server.connect(transport);
    console.error('Shadow CLJS MCP server running on stdio');
  }
}

const server = new ShadowCLJSServer();
server.run().catch(console.error);
