import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { get } from 'node:https';
import { customImageUrl } from '../src/model.js';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,prefix,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(ip,prefix,'ipv6');
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6 && global6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export async function resolvePublicImage(url, resolver = lookup) {
  if (!customImageUrl(url)) throw Error('请使用公开网站的 HTTPS 图片直链');
  const records = await resolver(new URL(url).hostname,{all:true,verbatim:true});
  if (!records.length || records.some(x=>!publicAddress(x.address))) throw Error('封面地址指向本机、内网或保留地址，已阻止');
  return records.find(x=>x.family===4) || records[0];
}
export async function customImageBody(url, {resolver = lookup, request = get, timeout = 7000} = {}) {
  const controller = new AbortController();
  const timeoutError = Error('封面连接超时');
  const timer = setTimeout(() => controller.abort(timeoutError), timeout);
  timer.unref?.();
  const signal = controller.signal;
  try {
    // One deadline covers DNS, TLS and body. A late DNS result never starts a request.
    const address = await new Promise((resolve,reject)=>{
      const abort = ()=>reject(timeoutError);
      signal.addEventListener('abort',abort,{once:true});
      resolvePublicImage(url,resolver).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    signal.throwIfAborted();
    return await new Promise((resolve,reject)=>{
      // Pin the validated IP; retain the URL hostname for SNI/certificate verification.
      // No redirects, proxy, cookies, authorization headers or connection reuse.
      const req = request(url, {agent:false,signal,autoSelectFamily:false,
        lookup:(_host,options,callback)=> options.all ? callback(null,[address]) : callback(null,address.address,address.family),
        headers:{Accept:'image/jpeg,image/png,image/webp','User-Agent':'Fandu/0.3'}
      }, res=>{
        res.on('error',reject);
        if (res.statusCode !== 200) {res.destroy();reject(Error('封面返回错误或跳转，请使用图片直链'));return;}
        if (Number(res.headers['content-length']) > 2*1024*1024) {res.destroy();reject(Error('封面不能超过 2 MB'));return;}
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){res.destroy(Error('封面不能超过 2 MB'));return;}chunks.push(chunk);});
        res.on('end',()=>resolve(Buffer.concat(chunks)));
      });
      req.on('error',reject);
    });
  } finally {
    clearTimeout(timer);
  }
}
