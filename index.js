#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import transit from 'transit-js';
import fetch from 'node-fetch';

class ShadowCLJSMonitor {
  constructor(host = 'localhost', port = 9630) {
    this.lastBuildStatus = null;
    this.writer = transit.writer('json');
    this.reader = transit.reader('json');
    this.connected = false;
    this.host = host;
    this.port = port;
  }

  transitMapToObject(val) {
    if (val && typeof val.get === 'function') {
      const obj = {};
      for (let key of val.keys()) {
        const rawKey = key.toString();
        const value = val.get(key);
        obj[rawKey] = this.transitMapToObject(value);
      }
      return obj;
    } else if (Array.isArray(val)) {
      return val.map(v => this.transitMapToObject(v));
    } else if (val && typeof val.toString === 'function') {
      return val.toString();
    }
    return val;
  }

  getLastBuildStatus() {
    const status = this.lastBuildStatus || {
      status: 'unknown',
      message: 'No build status available yet',
      timestamp: new Date().toISOString()
    };
    
    return {
      ...status,
      websocket_connected: this.connected
    };
  }

  async getServerToken() {
    while (true) {
      try {
        const response = await fetch(`http://${this.host}:${this.port}`);
        const html = await response.text();
        
        const tokenMatch = html.match(/<meta\s+content="([^"]+)"\s+name="shadow-remote-token"/);
        if (tokenMatch && tokenMatch[1]) {
          return { token: tokenMatch[1], port: this.port };
        }
      } catch (err) {
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async initWebSocket() {
    try {
      const { token, port } = await this.getServerToken();
      const ws = new WebSocket(`ws://${this.host}:${port}/api/remote-relay?id=shadow-cljs-monitor&server-token=${token}`);
      
      let initialized = false;
      
      ws.on('open', () => {
        this.connected = true;
      });
      
      ws.on('message', (data) => {
        try {
          const decoded = this.reader.read(data);
          if (!decoded) {
            return; 
          }
          
          const msg = this.transitMapToObject(decoded);
          if (!msg) {
            return;
          }
          
          const op = msg[':op'];
          
          if (!initialized && op === ':welcome') {
            initialized = true;
            this.sendInitializationMessages(ws);
          } else if (op === ':shadow.cljs/db-update') {
            const changes = msg[':changes'];
            if (!changes || !Array.isArray(changes)) {
              return;
            }

            for (const change of changes) {
              if (Array.isArray(change) && 
                  change[0] === ':entity-update' && 
                  change[1] === ':shadow.cljs/build' &&
                  change[3] === ':shadow.cljs/build-status') {
                
                const buildStatus = change[4];
                if (buildStatus && typeof buildStatus === 'object') {
                  this.lastBuildStatus = {
                    status: buildStatus[':status']?.toString().replace(':', '') || 'unknown',
                    timestamp: new Date().toISOString(),
                    resources: parseInt(buildStatus[':resources']) || 0,
                    compiled: parseInt(buildStatus[':compiled']) || 0,
                    duration: parseFloat(buildStatus[':duration']) || 0,
                    active: buildStatus[':active'] || {},
                    log: (buildStatus[':log'] || []).filter(entry => entry.startsWith('Compile CLJS:')),
                    warnings: Array.isArray(buildStatus[':warnings']) ? buildStatus[':warnings'] : [],
                    report: buildStatus[':report']
                  };
                }
              }
            }
          } else if (op === ':shadow.cljs.model/sub-msg') {
            this.handleBuildStatusUpdate(msg);
          } else if (op === ':ping') {
            const pongMsg = transit.map([transit.keyword('op'), transit.keyword('pong')]);
            const encoded = this.writer.write(pongMsg);
            ws.send(encoded);
          }
        } catch (err) {
          console.error('Error processing message:', err);
        }
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
      });

      ws.on('close', () => {
        this.connected = false;
        initialized = false;
        setTimeout(() => this.initWebSocket(), 2000);
      });
    } catch (err) {
      console.error('Failed to initialize WebSocket:', err);
      setTimeout(() => this.initWebSocket(), 2000);
    }
  }

  sendInitializationMessages(ws) {
    const sendMessage = (msg) => {
      const encoded = this.writer.write(msg);
      ws.send(encoded);
    };

    // Send hello
    const helloMsg = transit.map([
      transit.keyword('op'), transit.keyword('hello'),
      transit.keyword('client-info'), transit.map([
        transit.keyword('type'), transit.keyword('shadow-cljs-ui')
      ])
    ]);
    sendMessage(helloMsg);

    // Subscribe to supervisor updates
    const supervisorMsg = transit.map([
      transit.keyword('op'), transit.keyword('shadow.cljs.model/subscribe'),
      transit.keyword('to'), 1,
      transit.keyword('shadow.cljs.model/topic'), transit.keyword('shadow.cljs.model/supervisor')
    ]);
    sendMessage(supervisorMsg);

    // Subscribe to build status updates
    const buildStatusMsg = transit.map([
      transit.keyword('op'), transit.keyword('shadow.cljs.model/subscribe'),
      transit.keyword('to'), 1,
      transit.keyword('shadow.cljs.model/topic'), transit.keyword('shadow.cljs.model/build-status-update')
    ]);
    sendMessage(buildStatusMsg);

    // Initialize sync
    const dbSyncMsg = transit.map([
      transit.keyword('op'), transit.keyword('shadow.cljs/db-sync-init!'),
      transit.keyword('to'), 1
    ]);
    sendMessage(dbSyncMsg);
  }

  handleBuildStatusUpdate(msg) {
    const buildStatus = msg[':build-status'];
    const buildId = msg[':build-id'];
    if (buildStatus) {
      const status = buildStatus[':status'];
      const info = buildStatus[':info'] || {};
      const timings = info[':timings'] || {};
      
      let duration = null;
      if (timings[':compile-finish'] && timings[':compile-prepare']) {
        duration = (
          parseInt(timings[':compile-finish'][':exit']) - 
          parseInt(timings[':compile-prepare'][':enter'])
        ) / 1000.0;
      }
      
      this.lastBuildStatus = {
        buildId: buildId,
        status: status.replace(':', ''),
        timestamp: new Date().toISOString(),
        resources: buildStatus[':resources'],
        compiled: buildStatus[':compiled'],
        duration: duration,
        active: buildStatus[':active'],
        log: (buildStatus[':log'] || []).filter(entry => entry.startsWith('Compile CLJS:')),
        report: buildStatus[':report'],
        warnings: buildStatus[':warnings'] || [],
        cycle: info[':compile-cycle']
      };
    }
  }
}

class ShadowCLJSServer {
  constructor() {
    // Get arguments from process.argv
    const args = process.argv.slice(2);
    let host = 'localhost';
    let port = 9630;

    // Parse arguments looking for --host and --port
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--host' && i + 1 < args.length) {
        host = args[i + 1];
        i++;
      } else if (args[i] === '--port' && i + 1 < args.length) {
        port = parseInt(args[i + 1], 10);
        i++;
      }
    }

    this.monitor = new ShadowCLJSMonitor(host, port);
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
    await this.server.connect(transport);
    console.error('Shadow CLJS MCP server running on stdio');
    
    this.monitor.initWebSocket().catch(err => {
      console.error('Failed to initialize WebSocket:', err);
    });
  }
}

const server = new ShadowCLJSServer();
server.run().catch(console.error);
