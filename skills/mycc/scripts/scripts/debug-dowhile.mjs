#!/usr/bin/env node
/**
 * Debug patch: 给 cli.js do-while 循环加 debug 日志
 * 用完后跑 patch-sdk.mjs 恢复
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");

const src = readFileSync(CLI_PATH, "utf-8");

// Original do-while (with our FP patch applied)
const OLD = `do{for(let I6 of bM1())G.enqueue(I6);await R6(),E6=!1;{let I6=await $(),v6=tN8(I6).some((C6)=>FP(C6)),_6=l56();if(v6||_6){if(E6=!0,!_6)await new Promise((C6)=>setTimeout(C6,100))}}}while(E6)`;

const NEW = `do{for(let I6 of bM1())G.enqueue(I6);await R6(),E6=!1;{let I6=await $(),v6_tasks=tN8(I6),v6=v6_tasks.some((C6)=>FP(C6)),_6=l56();console.error("[DEBUG-DOWHILE]",JSON.stringify({taskCount:v6_tasks.length,tasks:v6_tasks.map(t=>({type:t.type,status:t.status,isIdle:t.isIdle,isBg:t.isBackgrounded,name:t.identity?.agentName})),blocking:v6,hasMsgs:_6}));if(v6||_6){if(E6=!0,!_6)await new Promise((C6)=>setTimeout(C6,100))}}}while(E6)`;

if (!src.includes(OLD)) {
  console.log("ERROR: do-while pattern not found. Current source around do{:");
  const idx = src.indexOf("do{for(let I6 of bM1()");
  if (idx !== -1) {
    console.log(src.substring(idx, idx + 400));
  } else {
    console.log("do{ pattern also not found!");
  }
  process.exit(1);
}

const patched = src.replace(OLD, NEW);
writeFileSync(CLI_PATH, patched, "utf-8");
console.log("[debug-dowhile] Debug logging injected into do-while loop");
console.log("[debug-dowhile] Logs go to stderr → mycc.log");
console.log("[debug-dowhile] To remove: re-run patch-sdk.mjs");
