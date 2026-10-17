const rgb=value=>{
  if(typeof value!=='string'||!/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value.trim()))throw Error('主题颜色无效');
  const hex=value.trim().slice(1),full=hex.length===3?[...hex].map(char=>char+char).join(''):hex;
  return full.match(/../g).map(channel=>parseInt(channel,16));
};
const luminance=value=>value.map(channel=>channel/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const mix=(a,b,weight)=>a.map((channel,index)=>Math.round(channel*(1-weight)+b[index]*weight));
const hex=value=>'#'+value.map(channel=>channel.toString(16).padStart(2,'0')).join('');
export const contrastRatio=(a,b)=>ratio(rgb(a),rgb(b));
export const onAccent=accent=>contrastRatio(accent,'#000000')>=contrastRatio(accent,'#ffffff')?'#000000':'#ffffff';

// Keep the user's decorative/fill accent unchanged. Only its text/focus
// counterpart is shaded toward the mode's ink, including tinted badge surfaces.
export function readableAccent(accent,surfaces,mode){
  if(!['dark','light'].includes(mode)||!Array.isArray(surfaces)||!surfaces.length)throw Error('主题表面无效');
  const color=rgb(accent),backgrounds=surfaces.map(rgb);
  const targets=backgrounds.flatMap(background=>[background,mix(background,color,.12),mix(background,color,.20)]);
  const ink=rgb(mode==='dark'?'#f6f8ff':'#101827');
  for(let step=0;step<=100;step++){
    const candidate=mix(color,ink,step/100);
    if(targets.every(background=>ratio(candidate,background)>=4.75))return hex(candidate);
  }
  throw Error('当前主题无法提供可读的强调文字');
}
