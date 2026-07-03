/**
 * Agent 群组路由模块
 *
 * 实现"群聊@所有人 → 智能路由给对应小工"的功能。
 *
 * 机制：
 * 1. 只拉1个"群主Bot"进群（如通道A）
 * 2. 群主Bot收到群消息后，AgentRouter 判断该谁回答
 * 3. 调用对应小工的 processMessage()，但劫持回复通道发到群里
 * 4. 从用户视角：5个小工都在，只有负责的回了
 */

import type { FeishuCommands } from "./channels/feishu-commands.js";
import type { FeishuMessageContext } from "./channels/feishu.js";

/** 小工配置 */
interface AgentConfig {
  id: string;
  name: string;
  keywords: string[];
  description: string;
}

/** 5个小工配置 —— 按优先级排序，先匹配先赢 */
const AGENT_CONFIGS: AgentConfig[] = [
  {
    id: "a",
    name: "技术助手",
    keywords: ["代码", "编程", "bug", "报错", "技术", "git", "部署", "服务器", "API", "接口", "程序"],
    description: "处理代码、技术问题、bug排查、部署相关",
  },
  {
    id: "b",
    name: "写作助手",
    keywords: ["文案", "文章", "标题", "公众号", "生财", "写作", "润色", "改写", "总结", "摘要"],
    description: "处理文案写作、文章润色、标题生成",
  },
  {
    id: "c",
    name: "数据分析",
    keywords: ["数据", "分析", "表格", "统计", "excel", "数字", "报表", "图表", "趋势"],
    description: "处理数据分析、表格处理、统计报告",
  },
  {
    id: "d",
    name: "社媒运营",
    keywords: ["小红书", "抖音", "推特", "运营", "涨粉", "视频", "社媒", "自媒体", "内容", "爆款"],
    description: "处理社媒运营、内容策略、涨粉方案",
  },
  {
    id: "e",
    name: "通用助手",
    keywords: ["*"],
    description: "兜底：处理不属于以上分类的问题",
  },
];

export class AgentRouter {
  private agents = new Map<string, FeishuCommands>();
  private mainChannel: any = null;
  private routingLocks = new Map<string, boolean>();

  /** 注册小工 */
  register(id: string, commands: FeishuCommands): void {
    this.agents.set(id.toLowerCase(), commands);
    console.log(`[AgentRouter] 注册小工: ${id}`);
  }

  /** 设置群主Bot的飞书通道（回复发到群里用） */
  setMainChannel(channel: any): void {
    this.mainChannel = channel;
    console.log("[AgentRouter] 群主通道已设置");
  }

  /** 判断消息该给哪个小工 —— 关键词匹配 */
  decide(message: string): { config: AgentConfig; matchedKeyword: string } {
    const lowerMsg = message.toLowerCase();

    for (const cfg of AGENT_CONFIGS) {
      // 跳过兜底项
      if (cfg.keywords[0] === "*") continue;

      for (const kw of cfg.keywords) {
        if (lowerMsg.includes(kw.toLowerCase())) {
          console.log(`[AgentRouter] 关键词匹配: "${kw}" → ${cfg.name} (${cfg.id})`);
          return { config: cfg, matchedKeyword: kw };
        }
      }
    }

    // 兜底：通用助手
    const fallback = AGENT_CONFIGS[AGENT_CONFIGS.length - 1];
    console.log(`[AgentRouter] 无关键词匹配 → 兜底到 ${fallback.name}`);
    return { config: fallback, matchedKeyword: "*" };
  }

  /** 路由消息给对应小工 */
  async route(
    message: string,
    images?: Array<{ data: string; mediaType: string }>,
    files?: Array<{ filePath: string; fileName: string }>,
    messageId?: string,
    ctx?: FeishuMessageContext,
  ): Promise<void> {
    const startTime = Date.now();
    const { config, matchedKeyword } = this.decide(message);
    const agent = this.agents.get(config.id);

    if (!agent) {
      console.error(`[AgentRouter] 小工 ${config.id}(${config.name}) 未注册，无法路由`);
      if (this.mainChannel) {
        await this.mainChannel.send({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `【系统】小工 ${config.name} 暂时不可用，请直接单独找它对话。`,
              },
            ],
          },
        } as any);
      }
      return;
    }

    // 检查是否正在处理中（简单锁，避免同一个小工被并发调用导致回复混乱）
    if (this.routingLocks.get(config.id)) {
      console.log(`[AgentRouter] 小工 ${config.name} 正在处理中，等待解锁...`);
      await this.waitForUnlock(config.id);
      if (this.routingLocks.get(config.id)) {
        console.warn(`[AgentRouter] 小工 ${config.name} 等待超时，消息丢弃`);
        if (this.mainChannel) {
          await this.mainChannel.send({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: `【${config.name}】正在忙，请稍后再试。` },
              ],
            },
          } as any);
        }
        return;
      }
    }
    this.routingLocks.set(config.id, true);

    console.log(`[AgentRouter] 路由: 关键词"${matchedKeyword}" → ${config.name}(${config.id}), 消息: "${message.substring(0, 40)}..."`);

    try {
      // 先发一条"认领"消息到群里
      if (this.mainChannel) {
        await this.mainChannel.send({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `【${config.name}】收到，正在处理...` }],
          },
        } as any);
      }

      // 劫持回复通道：让小工的回复发到群主通道（群里）
      agent.setReplyChannel(this.mainChannel);
      // 设置小工身份名称，群聊回复时自动加前缀
      agent.agentName = config.name;

      // 调用小工处理（保持它自己的 session/cwd 上下文，ctx 保证按群/话题隔离会话）
      await agent.processMessage(message, images, files, messageId, ctx);

      const elapsed = Date.now() - startTime;
      console.log(`[AgentRouter] 路由完成: ${config.name}, 耗时 ${elapsed}ms`);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.error(`[AgentRouter] 路由失败: ${config.name}, 耗时 ${elapsed}ms, 错误:`, err);
      if (this.mainChannel) {
        await this.mainChannel.send({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `【${config.name}】处理出错，请重试或直接单独找它对话。`,
              },
            ],
          },
        } as any);
      }
    } finally {
      agent.clearReplyChannel();
      this.routingLocks.set(config.id, false);
    }
  }

  /** 等待小工解锁 */
  private async waitForUnlock(agentId: string, maxWaitMs = 30000): Promise<void> {
    const start = Date.now();
    while (this.routingLocks.get(agentId)) {
      if (Date.now() - start > maxWaitMs) {
        console.warn(`[AgentRouter] 等待小工 ${agentId} 解锁超时，继续执行`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
