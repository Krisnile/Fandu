export const APP_URL='fandu://app/';
export function internalUrl(value) {
  try {const url=new URL(value);return url.protocol==='fandu:'&&url.hostname==='app'&&!url.port&&!url.username&&!url.password?url:null;}catch{return null;}
}
export function internalNavigation(value) {const url=internalUrl(value);return Boolean(url&&['/','/index.html'].includes(url.pathname));}
export function externalUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;
    if(!host.includes('.')||host.startsWith('[')||/^\d+(\.\d+){3}$/.test(host)||/(^|\.)(localhost|local|internal|test|onion)$/.test(host))return null;
    return url.href;
  }catch{return null;}
}
export function windowState(value,areas) {
  const base={width:1280,height:850};
  if(!value||typeof value!=='object')return base;
  const width=Number.isInteger(value.width)?Math.min(8192,Math.max(320,value.width)):base.width;
  const height=Number.isInteger(value.height)?Math.min(4320,Math.max(480,value.height)):base.height;
  const result={width,height,maximized:value.maximized===true};
  if(Number.isInteger(value.x)&&Number.isInteger(value.y)&&areas.some(a=>value.x+width>a.x+64&&value.x<a.x+a.width-64&&value.y>=a.y&&value.y<a.y+a.height-32)){result.x=value.x;result.y=value.y;}
  return result;
}
