#!/usr/bin/env node
/** Upload a user-selected file using the same private credential as mcp-bridge.mjs. */
import {readFile,stat} from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
async function main(){
  const configPath=process.env.VH_MCP_CONFIG,filePath=process.argv[2];
  if(!configPath||!path.isAbsolute(configPath)||!filePath||!path.isAbsolute(filePath))throw new Error("Set VH_MCP_CONFIG and provide one absolute file path.");
  const permissions=await stat(configPath);if((permissions.mode&0o077)!==0)throw new Error("MCP configuration must have permissions 0600.");
  const config=JSON.parse(await readFile(configPath,"utf8")),url=new URL(config.url);
  if(url.username||url.password||url.search||url.hash||url.pathname!=="/mcp")throw new Error("Invalid MCP endpoint.");
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw new Error("HTTPS is required except on loopback.");
  if(typeof config.token!=="string"||!/^vh_mcp_[A-Za-z0-9_-]{43}$/.test(config.token))throw new Error("Invalid MCP token.");
  const file=await stat(filePath);if(!file.isFile())throw new Error("Select a regular file.");
  url.pathname="/mcp";
  const response=await fetch(url,{method:"PUT",headers:{Authorization:`Bearer ${config.token}`,"Content-Type":"application/octet-stream","Content-Length":String(file.size),"X-VH-Filename":encodeURIComponent(path.basename(filePath))},body:createReadStream(filePath),duplex:"half"});
  const body=await response.text();
  if(!response.ok){process.stderr.write(`Upload failed (${response.status}): ${body}\n`);process.exitCode=1;return;}
  process.stdout.write(`${body}\n`);
}
main().catch(()=>{process.stderr.write("Upload could not run. Check the private config, file path and network.\n");process.exitCode=1;});
