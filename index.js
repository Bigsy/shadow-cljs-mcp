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
      // Handle transit maps
      const obj = {};
      for (let key of val.keys()) {
        const rawKey = key.toString();
        const value = val.get(key);
        obj[rawKey] = this.transitMapToObject(value);
      }
      return obj;
    } else if (Array.isArray(val)) {
      // Handle arrays
      return val.map(v => this.transitMapToObject(v));
    } else if (val && typeof val.toString === 'function') {
      // Handle other transit values
      return val.toString();
    }
    // Return primitive values as-is
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
        console.log(`Trying to connect to shadow-cljs at ${this.host}:${this.port}...`);
        const response = await fetch(`http://${this.host}:${this.port}`);
        const html = await response.text();
        
        const tokenMatch = html.match(/<meta\s+content="([^"]+)"\s+name="shadow-remote-token"/);
        if (tokenMatch && tokenMatch[1]) {
          console.log(`Successfully connected to ${this.host}:${this.port}`);
          return { token: tokenMatch[1], port: this.port };
        }
      } catch (err) {
        console.log(`Could not connect to ${this.host}:${this.port}: ${err.message}`);
      }
      console.log('Could not connect to shadow-cljs server, retrying in 2 seconds...');
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
          console.log('\n[Raw WebSocket Message]');
          console.log(data.toString());

          const decoded = this.reader.read(data);
          if (!decoded) {
            console.log('[Decode Failed]');
            return;
          }
          
          const msg = this.transitMapToObject(decoded);
          if (!msg) {
            console.log('[Transit Map Failed]');
            return;
          }
          
          const op = msg[':op'];
          console.log('[Message Received]', op);
          
          if (!initialized && op === ':welcome') {
            console.log('\n[Welcome Message Received]');
            console.log('Raw message:', JSON.stringify(msg, null, 2));
            initialized = true;
            console.log('[Sending Initialization Messages]');
            this.sendInitializationMessages(ws);
          } else if (op === ':shadow.cljs/db-update') {
            console.log('\n[DB Update Message]');
            console.log('Raw message:', JSON.stringify(msg, null, 2));
            const changes = msg[':changes'];
            if (!changes) {
              console.log('No changes found in message');
            } else if (typeof changes !== 'string') {
              console.log('Changes is not a string:', typeof changes, changes);
            } else {
              if (changes.includes(':status => :failed')) {
                console.log('[DB Update] Build failed');
                this.lastBuildStatus = {
                  status: 'failed',
                  message: 'Build failed',
                  details: msg,
                  timestamp: new Date().toISOString()
                };
              } else if (changes.includes(':status => :completed')) {
                console.log('[DB Update] Build completed');
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
          } else if (op === ':shadow.cljs/db-sync') {
            console.log('\n[DB Sync Message]');
            console.log('Raw message:', JSON.stringify(msg, null, 2));
          } else if (op === ':shadow.cljs.model/sub-msg') {
            this.handleBuildStatusUpdate(msg);
          } else if (op === ':ping') {
            console.log('\n[Ping Received]');
            const pongMsg = transit.map([transit.keyword('op'), transit.keyword('pong')]);
            const encoded = this.writer.write(pongMsg);
            console.log('[Sending Pong]:', encoded);
            ws.send(encoded);
          } else if (op === ':pong') {
            console.log('\n[Pong Received]');
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
    const sendMessage = (msg, desc) => {
      console.log(`[Sending ${desc}]`);
      const encoded = this.writer.write(msg);
      console.log('Message:', encoded);
      ws.send(encoded);
    };

    // Send hello
    const helloMsg = transit.map([
      transit.keyword('op'), transit.keyword('hello'),
      transit.keyword('client-info'), transit.map([
        transit.keyword('type'), transit.keyword('shadow-cljs-ui')
      ])
    ]);
    sendMessage(helloMsg, 'Hello');

    // Subscribe to supervisor updates
    const supervisorMsg = transit.map([
      transit.keyword('op'), transit.keyword('shadow.cljs.model/subscribe'),
      transit.keyword('to'), 1,
      transit.keyword('shadow.cljs.model/topic'), transit.keyword('shadow.cljs.model/supervisor')
    ]);
    sendMessage(supervisorMsg, 'Supervisor Subscribe');

    // Subscribe to build status updates
    const buildStatusMsg = transit.map([
      transit.keyword('op'), transit.keyword('shadow.cljs.model/subscribe'),
      transit.keyword('to'), 1,
      transit.keyword('shadow.cljs.model/topic'), transit.keyword('shadow.cljs.model/build-status-update')
    ]);
    sendMessage(buildStatusMsg, 'Build Status Subscribe');

    // Initialize sync
    const dbSyncMsg = transit.map([
      transit.keyword('op'), transit.keyword('shadow.cljs/db-sync-init!'),
      transit.keyword('to'), 1
    ]);
    sendMessage(dbSyncMsg, 'DB Sync Init');
  }

  handleBuildStatusUpdate(msg) {
    console.log('\n[Build Message Received]');
    console.log('Raw message:', JSON.stringify(msg, null, 2));
    
    const buildStatus = msg[':build-status'];
    const buildId = msg[':build-id'];
    if (buildStatus) {
      const status = buildStatus[':status'];
      const info = buildStatus[':info'] || {};
      const timings = info[':timings'] || {};
      
      console.log(`[Build Status Update] Build ID: ${buildId}, Status: ${status}`);
      
      // Calculate build duration if available
      let duration = null;
      if (timings[':compile-finish'] && timings[':compile-prepare']) {
        duration = (
          parseInt(timings[':compile-finish'][':exit']) - 
          parseInt(timings[':compile-prepare'][':enter'])
        ) / 1000.0; // Convert to seconds
      }
      
      this.lastBuildStatus = {
        buildId: buildId,
        status: status.replace(':', ''),
        timestamp: new Date().toISOString(),
        resources: buildStatus[':resources'],
        compiled: buildStatus[':compiled'],
        duration: duration,
        active: buildStatus[':active'],
        log: buildStatus[':log'] || [],
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
    
    // Start WebSocket connection in the background
    this.monitor.initWebSocket().catch(err => {
      console.error('Failed to initialize WebSocket:', err);
    });
  }
}

const server = new ShadowCLJSServer();
server.run().catch(console.error);
