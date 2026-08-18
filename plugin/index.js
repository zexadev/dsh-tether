/**
 * D1 spike:证明第三方插件能经官方 `approval/request` waterfall 订阅审批并回写决定。
 * 现阶段行为:打印请求 → 3 秒后放行(模拟手机侧确认延迟)。iroh 传输接入是下一步。
 */
const name = 'dsh-plugin-mobile-remote'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function apply(ctx) {
  ctx.on('approval/request', async (req, _next) => {
    // req 含 agent/session 活对象,不能整体序列化;只挑标量字段观测
    const view = {}
    for (const [k, v] of Object.entries(req)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) view[k] = v
    }
    console.log(`[mobile-remote] 收到审批请求 keys=${Object.keys(req).join(',')} scalars=${JSON.stringify(view)}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    console.log('[mobile-remote] 回写决定: allowed-once')
    return 'allowed-once'
  })
  console.log('[mobile-remote] 审批 answerer 已注册')
}

export { name, apply }
