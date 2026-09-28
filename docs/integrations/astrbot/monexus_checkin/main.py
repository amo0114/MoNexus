"""MoNexus 签到机器人插件 — AstrBot。

SPEC-CHAT-BOT-001 的机器人侧实现。能力：
  1. /绑定 <邮箱> + /确认   —— 群内两步绑定，全程不离开 QQ
  2. 签到 / 打卡            —— 私聊或群聊签到（群聊需 @机器人）
  3. 我的积分               —— 查积分余额 + 会员等级 + 今日签到状态
  4. /解绑                  —— 解除绑定
  5. 定时催签               —— 每天定点私聊今日未签到的已绑定用户

设计约束（与后端契约必须严格一致）：
  - 所有请求走 POST /api/bot/*，用 HMAC-SHA256 签名
  - 签名串 = 按 key 字典序拼 `k=v&k=v`，值不做 URL 编码
  - 参与签名的字段：请求体所有字段 + timestamp + _path
  - 头部：X-Bot-Sign / X-Bot-Timestamp；时间戳容差 ±5 分钟
  - 请求体绝不携带 userId —— 身份由后端用 platformId 反查绑定表

QQ 号必须当字符串处理：18 位以上的 QQ 号超出 JS/Python 数字安全范围，
一旦被解析成 int 再拿去签名，必然与后端对不上。
"""

import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime

import aiohttp

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

PLUGIN_NAME = "astrbot_plugin_monexus_checkin"


@register(
    PLUGIN_NAME,
    "MoNexus",
    "MoNexus 积分平台签到：账号绑定、群/私聊签到、积分等级查询、定时催签",
    "1.0.0",
)
class MoNexusCheckin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

        self.api_base = str(self.config.get("api_base", "")).rstrip("/")
        self.secret = str(self.config.get("bot_secret", ""))
        # 配置里的 platform 只作为「事件读不到平台名」时的兜底。
        # 正常路径一律走 _platform(event)，理由见该方法注释。
        self.platform = str(self.config.get("platform", "qq")).lower()

        self.reminder_enabled = bool(self.config.get("reminder_enabled", True))
        self.reminder_hour = int(self.config.get("reminder_hour", 21))
        self.reminder_minute = int(self.config.get("reminder_minute", 0))
        self.reminder_message = str(
            self.config.get(
                "reminder_message",
                "今天还没签到哦，回复「签到」即可领取积分～",
            )
        )
        self.group_at_enabled = bool(self.config.get("group_at_required", True))

        if not self.api_base or not self.secret:
            logger.warning(
                "[MoNexus] api_base / bot_secret 未配置，签到插件不会生效。"
                "请在插件配置中填写后端地址与 BOT_SHARED_SECRET。"
            )

        if self.reminder_enabled and self._ready():
            self._register_reminder_job()

    # ── 基础设施 ────────────────────────────────────────────────────────

    def _ready(self) -> bool:
        return bool(self.api_base and self.secret)

    @staticmethod
    def _sign_payload(params: dict) -> str:
        """按字典序拼签名串；跳过 None，且不包含 sign 自身。"""
        keys = sorted(k for k, v in params.items() if k != "sign" and v is not None)
        return "&".join(f"{k}={params[k]}" for k in keys)

    def _sign(self, params: dict) -> tuple[str, int]:
        ts = int(time.time() * 1000)
        signed = dict(params)
        signed["timestamp"] = ts
        payload = self._sign_payload(signed)
        digest = hmac.new(
            self.secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return digest, ts

    async def _call(self, path: str, payload: dict) -> dict:
        """POST /api/bot{path}，带 HMAC 签名。失败返回 {'_error': ...}。"""
        if not self._ready():
            return {"_error": "插件未配置 api_base / bot_secret"}

        # _path 必须参与签名：否则一个合法签名会被挪用到别的接口。
        body = dict(payload)
        sign, ts = self._sign({**body, "_path": path})
        url = f"{self.api_base}/api/bot{path}"
        headers = {
            "Content-Type": "application/json",
            "X-Bot-Sign": sign,
            "X-Bot-Timestamp": str(ts),
        }

        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json=body, headers=headers) as resp:
                    text = await resp.text()
                    if resp.status >= 400:
                        try:
                            detail = json.loads(text)
                            msg = detail.get("error", {}).get("message", text)
                        except Exception:
                            msg = text
                        logger.warning(f"[MoNexus] {path} -> {resp.status}: {msg}")
                        return {"_error": msg}
                    return json.loads(text) if text else {}
        except asyncio.TimeoutError:
            return {"_error": "请求超时，请稍后再试"}
        except Exception as exc:  # noqa: BLE001 - 网络异常一律转成用户可读文案
            logger.error(f"[MoNexus] {path} 请求失败: {exc}")
            return {"_error": "服务暂时不可用，请稍后再试"}

    def _uid(self, event: AstrMessageEvent) -> str:
        """平台账号标识，强制字符串化以保住长 QQ 号的精度。"""
        return str(event.get_sender_id())

    def _platform(self, event: AstrMessageEvent) -> str:
        """当前事件来自哪个平台，用于后端 (platform, platformId) 复合键。

        ⚠️ 不能直接用配置里写死的 platform。同一个 AstrBot 实例可以同时挂
        QQ 和 Telegram 适配器：若配置写死 'qq'，TG 用户会用 (qq, <tg_id>)
        去查绑定表——一旦某个 TG 用户 ID 与某个 QQ 号数值相同，就会命中
        别人的账号，签到积分记到他人名下。串号属于数据错误，不是显示问题。

        所以优先从事件读平台名；读不到（旧版本 API 差异）才回退配置值。
        """
        for getter in ("get_platform_name", "get_platform_id"):
            fn = getattr(event, getter, None)
            if not callable(fn):
                continue
            try:
                name = str(fn() or "").strip().lower()
            except Exception:  # noqa: BLE001 - 不同适配器实现差异
                continue
            if name:
                return name
        return self.platform

    # ── 命令：绑定 / 解绑 ───────────────────────────────────────────────

    @filter.command("绑定")
    async def bind(self, event: AstrMessageEvent, email: str = ""):
        """绑定站内账号：/绑定 you@example.com"""
        email = (email or "").strip()
        if not email:
            yield event.plain_result(
                "用法：/绑定 <注册邮箱>\n"
                "例：/绑定 you@example.com\n"
                "我们会往该邮箱发送 6 位验证码，收到后发送：/确认 <验证码>"
            )
            return

        result = await self._call(
            "/bind/request",
            {"platform": self._platform(event), "platformId": self._uid(event), "email": email},
        )
        if "_error" in result:
            yield event.plain_result(f"发送失败：{result['_error']}")
            return

        # 后端对「邮箱不存在」也返回成功，避免账号枚举。这里文案保持中性。
        yield event.plain_result(
            "如果该邮箱已注册，验证码已发送。\n"
            "请在 10 分钟内发送：/确认 <6 位验证码>"
        )

    @filter.command("确认")
    async def confirm(self, event: AstrMessageEvent, code: str = ""):
        """确认绑定：/确认 123456"""
        code = (code or "").strip()
        if not code:
            yield event.plain_result("用法：/确认 <6 位验证码>")
            return

        result = await self._call(
            "/bind/confirm",
            {"platform": self._platform(event), "platformId": self._uid(event), "code": code},
        )
        if "_error" in result:
            yield event.plain_result(f"绑定失败：{result['_error']}")
            return

        nickname = result.get("nickname") or f"用户{result.get('userId')}"
        yield event.plain_result(
            f"绑定成功，欢迎 {nickname}！\n"
            "现在可以发送「签到」领取每日积分，或发送「我的积分」查看余额。"
        )

    @filter.command("解绑")
    async def unbind(self, event: AstrMessageEvent):
        """解除 QQ 与站内账号的绑定。"""
        result = await self._call(
            "/unbind", {"platform": self._platform(event), "platformId": self._uid(event)}
        )
        if "_error" in result:
            yield event.plain_result(f"解绑失败：{result['_error']}")
            return
        if not result.get("unbound"):
            yield event.plain_result("当前账号尚未绑定，无需解绑。")
            return
        yield event.plain_result(
            "已解绑。如需重新绑定，请发送：/绑定 <注册邮箱>"
        )

    # ── 命令：签到 ──────────────────────────────────────────────────────

    @filter.command("签到")
    async def checkin(self, event: AstrMessageEvent):
        """每日签到领积分。"""
        async for r in self._do_checkin(event):
            yield r

    @filter.command("打卡")
    async def checkin_alias(self, event: AstrMessageEvent):
        """「打卡」是「签到」的别名。"""
        async for r in self._do_checkin(event):
            yield r

    async def _do_checkin(self, event: AstrMessageEvent):
        # 群里不 @机器人就签到，会刷屏。默认要求 @，可按配置放宽。
        if self.group_at_enabled and event.get_group_id() and not event.is_at_or_wake_command:
            return

        result = await self._call(
            "/checkin", {"platform": self._platform(event), "platformId": self._uid(event)}
        )
        if "_error" in result:
            yield event.plain_result(f"签到失败：{result['_error']}")
            return
        if not result.get("bound"):
            yield event.plain_result(
                "你还没有绑定账号。\n"
                "请发送：/绑定 <注册邮箱>，然后按提示发送 /确认 <验证码>"
            )
            return

        if result.get("alreadyCheckedIn"):
            yield event.plain_result("今天已经签到过啦，明天再来～")
            return

        total = result.get("totalReward", 0)
        bonus = result.get("bonusReward", 0)
        lines = [f"签到成功，积分 +{total}！"]
        if bonus:
            lines.append(f"（含会员等级加成 +{bonus}）")
        lines.append(f"当前可用积分：{result.get('balanceAfter', 0)}")
        yield event.plain_result("\n".join(lines))

    # ── 命令：查询 ──────────────────────────────────────────────────────

    @filter.command("我的积分")
    async def profile(self, event: AstrMessageEvent):
        """查询积分余额、会员等级与今日签到状态。"""
        result = await self._call(
            "/profile", {"platform": self._platform(event), "platformId": self._uid(event)}
        )
        if "_error" in result:
            yield event.plain_result(f"查询失败：{result['_error']}")
            return
        if not result.get("bound"):
            yield event.plain_result(
                "你还没有绑定账号。\n"
                "请发送：/绑定 <注册邮箱>，然后按提示发送 /确认 <验证码>"
            )
            return

        tier = result.get("tier") or {}
        label = tier.get("label") or "—"
        lifetime = tier.get("lifetimeEarnedPoints", 0)
        to_next = tier.get("pointsToNextTier", 0)
        next_tier = tier.get("nextTier")

        lines = [
            f"可用积分：{result.get('balance', 0)}",
            f"会员等级：{label}",
            f"累计获得：{lifetime}",
        ]
        if next_tier and to_next:
            lines.append(f"距离下一等级还差 {to_next} 分")
        lines.append("今日签到：已签" if result.get("checkedInToday") else "今日签到：未签")

        frozen = result.get("frozenBalance", 0)
        if frozen:
            lines.append(f"（冻结中：{frozen}）")

        yield event.plain_result("\n".join(lines))

    # ── 定时催签 ────────────────────────────────────────────────────────

    def _register_reminder_job(self):
        try:
            scheduler = self.context.get_scheduler()
        except Exception as exc:  # noqa: BLE001 - 不同版本 API 差异
            logger.warning(f"[MoNexus] 无法获取调度器，定时催签未启用: {exc}")
            return

        scheduler.add_job(
            self._remind_unchecked,
            trigger="cron",
            hour=self.reminder_hour,
            minute=self.reminder_minute,
            id="monexus_checkin_reminder",
            replace_existing=True,
            misfire_grace_time=300,
        )
        logger.info(
            f"[MoNexus] 定时催签已注册：每天 {self.reminder_hour:02d}:"
            f"{self.reminder_minute:02d}"
        )

    async def _remind_unchecked(self):
        """拉取今日未签到的已绑定用户，逐个私聊提醒。"""
        result = await self._call("/unchecked", {"platform": self.platform})
        if "_error" in result:
            logger.warning(f"[MoNexus] 催签名单拉取失败：{result['_error']}")
            return

        users = result.get("users", [])
        if not users:
            logger.info("[MoNexus] 今日全员已签到，无需催签。")
            return

        sent = 0
        for u in users:
            platform_id = str(u.get("platformId") or "")
            if not platform_id:
                continue
            try:
                await self.context.send_private_message(
                    user_id=platform_id, message=self.reminder_message
                )
                sent += 1
                # 逐个限速：QQ 对主动私聊有风控，太快会被限制。
                await asyncio.sleep(1.5)
            except Exception as exc:  # noqa: BLE001 - 单人失败不应中断整批
                logger.debug(f"[MoNexus] 私聊 {platform_id} 失败: {exc}")

        logger.info(f"[MoNexus] 催签完成：{sent}/{len(users)} 条已发送")

    # ── 生命周期 ────────────────────────────────────────────────────────

    async def terminate(self):
        """插件卸载时移除定时任务，避免热重载后重复注册。"""
        try:
            scheduler = self.context.get_scheduler()
            scheduler.remove_job("monexus_checkin_reminder")
        except Exception:  # noqa: BLE001 - 未注册或已移除都无需处理
            pass
        logger.info("[MoNexus] 插件已卸载，定时任务已清理。")
