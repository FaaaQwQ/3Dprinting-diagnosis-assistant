import { materials, defects, toolSchemas, systemPrompt } from './knowledge.mjs';
export { toolSchemas, systemPrompt };
export const materialRows = Object.entries(materials).map(([key, m]) => {
  const range = m.nozzle.match(/(\d+)-(\d+)/);
  return { key, ...m, nozzle_lo: range ? +range[1] : null, nozzle_hi: range ? +range[2] : null };
});
const aliases = {'pla pro':'pla+','plaplus':'pla+','尼龙':'pa','pa12':'pa','pa6':'pa','nylon':'pa','聚碳酸酯':'pc','水溶':'pva','木质':'wood','木塑':'wood','pact':'pa-cf','paht':'pa-cf','碳纤维尼龙':'pa-cf','hips 支撑':'hips'};
function number(args, key, fallback, min = 0, inclusive = false) {
  const value = Number(args[key] ?? fallback);
  if (!Number.isFinite(value) || (inclusive ? value < min : value <= min)) throw new Error(`${key} 必须为${inclusive ? '不小于' : '大于'} ${min} 的数字`);
  return value;
}
export function runTool(name, args = {}) {
  if (name === 'diagnose_defect') {
    const text = String(args.symptom || '').toLowerCase().trim();
    const matches = Object.values(defects).filter(d => d.symptoms.some(kw => text.includes(kw.toLowerCase())) || text.includes(d.name.toLowerCase()));
    if (!matches.length) return '未识别出具体缺陷，请补充明确症状，如拉丝、翘边、层间开裂、错层、第一层粘不住、堵头。';
    return matches.map(d => `【${d.name}】\n` + [['可能原因','causes'],['排查步骤','checks'],['修复建议','fixes']].map(([title,key]) => `◆ ${title}：\n${d[key].map((s,i)=>`${i+1}. ${s}`).join('\n')}`).join('\n')).join('\n\n');
  }
  if (name === 'recommend_temperature') {
    const input = String(args.material || '').toLowerCase().trim();
    const m = materials[aliases[input] || input] || Object.values(materials).find(m => m.name.toLowerCase() === input);
    if (!m) return `暂不支持材料「${args.material || ''}」。支持：${Object.values(materials).map(m=>m.name).join('、')}`;
    return `【${m.name}】打印参数推荐\n🌡 喷嘴温度：${m.nozzle}\n🔥 热床温度：${m.bed}\n📦 舱体要求：${m.enclosure}\n💡 注意事项：${m.notes}`;
  }
  if (name === 'calc_print_params') {
    const n=number(args,'nozzle_diameter',0.4), l=number(args,'layer_height',0.2), w=number(args,'wall_count',3,0,true), f=number(args,'infill_density',20,0,true), s=number(args,'print_speed',60);
    if (!Number.isInteger(w) || f>100) throw new Error('壁数必须是非负整数，填充必须在 0–100% 之间');
    const line=n*1.1, flow=line*l*s, issues=[];
    if (l<n*.15) issues.push('层高过低，可能导致打印时间增加、材料降解');
    if (l>n*.75) issues.push('层高过高，可能导致层间粘合差、表面粗糙');
    if (flow>12) issues.push('体积流量超过常规热端约 12 mm³/s，建议降低速度或使用大流量热端');
    else if (flow>8) issues.push('体积流量偏高，请注意热端保温');
    if (f<10 && w<2) issues.push('壁数和填充偏低，结构强度不足');
    return `【打印参数计算结果】（喷嘴 ${n}mm）\n📏 挤出线宽 ≈ ${line.toFixed(2)}mm（推荐范围 ${(n*.9).toFixed(2)}~${(n*1.2).toFixed(2)}mm）\n🧱 壁厚 ≈ ${(line*w).toFixed(2)}mm（${w} 层壁）\n🕳 层高 ${l}mm（合理范围 ${(n*.15).toFixed(2)}~${(n*.75).toFixed(2)}mm）\n⚡ 体积流量 ≈ ${flow.toFixed(1)} mm³/s\n检查结果：${issues.length ? issues.join('；') : '✅ 参数合理'}\n💡 建议：机械件/承重件壁数≥3、填充≥30%；外观件填充 15–20% 即可；悬空结构需支撑或开启桥接优化。`;
  }
  if (name === 'estimate_print_time') {
    const w=number(args,'model_weight_g',0), l=number(args,'layer_height',.2), n=number(args,'nozzle_diameter',.4), s=number(args,'print_speed',60), d=number(args,'material_density',1.24);
    const volume=w/d*1000, line=n*1.1, length=volume/(line*l), hours=length/(s*.7)/3600;
    const fmt=h => h<1 ? `${(h*60).toFixed(0)} 分钟` : `${h.toFixed(1)} 小时`;
    return `【打印时间估算】\n模型重量：${w}g，材料密度：${d} g/cm³\n层高 ${l}mm × 线宽 ${line.toFixed(2)}mm × 速度 ${s}mm/s\n耗材体积 ≈ ${(volume/1000).toFixed(1)} cm³，挤出路径总长 ≈ ${(length/1000).toFixed(1)} m\n⏱ 估算打印时间：约 ${fmt(hours*.9)} ~ ${fmt(hours*1.1)}\n💡 简化估算已按 70% 有效速度折算加速、移动和回抽损耗，±10% 波动；实际时间以切片器为准。`;
  }
  throw new Error('不支持的工具');
}
