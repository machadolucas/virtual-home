#!/usr/bin/env node
/** Local stdio adapter. The private token never appears in argv, stdout, or repository config. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const configPath=process.env.VH_MCP_CONFIG;
  if(!configPath||!path.isAbsolute(configPath)) throw new Error("Set VH_MCP_CONFIG to an absolute private JSON config path.");
  const mode=await stat(configPath);
  if(!mode.isFile()||(mode.mode&0o077)!==0) throw new Error("MCP configuration must be a private file (chmod 600).");
  const config=JSON.parse(await readFile(configPath,"utf8"));
  const url=new URL(config.url);
  if(url.username||url.password||url.search||url.hash||url.pathname!=="/mcp") throw new Error("Expected an MCP endpoint URL without credentials or query.");
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Use HTTPS, or HTTP on loopback only.");
  if(typeof config.token!=="string"||!/^vh_mcp_[A-Za-z0-9_-]{43}$/.test(config.token)) throw new Error("Invalid MCP token format.");
  const local=new StdioServerTransport();
  const remote=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${config.token}`}},reconnectionOptions:{maxReconnectionDelay:5000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1.5,maxRetries:2}});
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await Promise.allSettled([local.close(),remote.close()]);};
  const failed=()=>{process.stderr.write("virtual-home MCP connection failed. Check the endpoint, network, token expiry and access.\n");void close().finally(()=>{process.exitCode=1;});};
  local.onmessage=message=>{void remote.send(message).catch(failed);};
  remote.onmessage=message=>{void local.send(message).catch(failed);};
  local.onerror=failed;remote.onerror=failed;
  local.onclose=()=>{void close();};remote.onclose=()=>{void close();};
  process.on("SIGINT",()=>{void close();});process.on("SIGTERM",()=>{void close();});
  await remote.start();await local.start();
}
main().catch(error=>{process.stderr.write(`virtual-home MCP: ${error instanceof SyntaxError?"Invalid private configuration JSON.":error instanceof Error?error.message:"Startup failed."}\n`);process.exitCode=1;});
