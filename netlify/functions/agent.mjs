import { materialRows, runTool, toolSchemas, systemPrompt } from './_shared/tools.mjs';
import strategies from './_shared/strategies.json' with { type: 'json' };
const reply = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
export default async function handler(req) {
  const route = new URL(req.url).pathname.replace('/agent/api/', '');
  const key = Netlify.env.get('DEEPSEEK_API_KEY');
  if (req.method === 'GET' && route === 'status') return reply({agent_ready: Boolean(key), materials: materialRows.map(m=>m.name)});
  if (req.method === 'GET' && route === 'materials') return reply(materialRows);
  if (req.method !== 'POST') return reply({error:'不支持的请求方式'},405);
  const raw = await req.text();
  if (raw.length>40000) return reply({error:'对话过长，请缩短问题后重试'},413);
  let data;
  try { data=JSON.parse(raw); if (!data || typeof data!=='object' || Array.isArray(data)) throw new Error(); }
  catch { return reply({error:'请求格式不正确'},400); }
  const names={'tool/temperature':'recommend_temperature','tool/params':'calc_print_params','tool/time':'estimate_print_time'};
  if (names[route]) {
    try { return reply({result:runTool(names[route],data)}); }
    catch(e) { return reply({error:e.message},400); }
  }
  if (route!=='chat') return reply({error:'接口不存在'},404);
  const strategy=data.strategy ?? 'candidate';
  if (typeof strategy!=='string' || !Object.hasOwn(strategies,strategy)) return reply({error:'未知策略版本'},400);
  if (!key) return reply({error:'对话服务暂未配置，打印工具仍可使用。'},503);
  const text = typeof data.message==='string' ? data.message.trim() : '';
  if (!text || text.length>2000) return reply({error:'请输入 1–2000 字的打印问题'},400);
  const history = Array.isArray(data.history) ? data.history.slice(-10).filter(m=>m && ['user','assistant'].includes(m.role) && typeof m.content==='string').map(m=>({role:m.role,content:m.content.slice(0,2000)})) : [];
  // History is request-local: no shared mutable conversations between visitors.
  const messages=[{role:'system',content:systemPrompt+'\n回答简洁，优先给出三条可执行建议。只处理 3D 打印相关问题。\n'+strategies[strategy].prompt},...history,{role:'user',content:text}];
  const base=(Netlify.env.get('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/$/,'');
  const usedTools=[];
  const started=Date.now();
  let totalTokens=0, usageKnown=true;
  const signal=AbortSignal.timeout(52000);
  try {
    for (let round=0;round<4;round++) {
      const res=await fetch(base+'/chat/completions',{method:'POST',signal,headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'deepseek-v4-flash',thinking:{type:'disabled'},messages,tools:toolSchemas,tool_choice:round===3?'none':'auto',max_tokens:1400})});
      if (!res.ok) {
        console.error('DeepSeek request failed:',res.status);
        return reply({error:res.status===429?'当前请求较多，请稍后重试。':'模型服务暂时不可用，请稍后重试。'},502);
      }
      const result=await res.json();
      if (Number.isFinite(result.usage?.total_tokens)) totalTokens+=result.usage.total_tokens;
      else usageKnown=false;
      const message=result.choices?.[0]?.message;
      if (!message) return reply({error:'模型未返回有效内容，请重试。'},502);
      if (!message.tool_calls?.length) {
        if (!message.content) return reply({error:'模型未返回有效内容，请重试。'},502);
        return reply({reply:message.content,tools_used:usedTools,strategy,strategy_version:strategies[strategy].version,model:'deepseek-v4-flash',latency_ms:Date.now()-started,usage:usageKnown?{total_tokens:totalTokens}:null});
      }
      messages.push(message);
      for (const call of message.tool_calls) {
        let content;
        try { content=runTool(call.function.name,JSON.parse(call.function.arguments)); usedTools.push(call.function.name); }
        catch(e) { content='工具参数错误：'+e.message; }
        messages.push({role:'tool',tool_call_id:call.id,content});
      }
    }
    return reply({error:'本次分析步骤较多，请把问题拆小后重试。'},502);
  } catch(e) {
    console.error('Agent request failed:',e.name);
    return reply({error:signal.aborted?'分析超时，请缩短问题后重试。':'模型连接暂时失败，请稍后重试。'},504);
  }
}
export const config = {
  path: ['/agent/api/status','/agent/api/materials','/agent/api/chat','/agent/api/tool/temperature','/agent/api/tool/params','/agent/api/tool/time'],
  rateLimit: {windowLimit: 20, windowSize: 60, aggregateBy: ['ip','domain']}
};
