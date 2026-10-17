// Runs inside the browser. This is an evidence collector for solid-background
// text, not a substitute for inspecting photographs, gradients or focus rings.
export function auditTextContrast(rootSelector){
  const root=document.querySelector(rootSelector),canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const rgba=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].map((value,index)=>index===3?value/255:value);};
  const blend=(top,bottom)=>top.slice(0,3).map((value,index)=>value*top[3]+bottom[index]*(1-top[3]));
  const luminance=rgb=>rgb.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const samples=[],review=[];
  for(const element of [root,...root.querySelectorAll('*')]){
    if(!element.getClientRects().length || element.closest('[inert],[aria-hidden=true],.sr-only,button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled=true]'))continue;
    const style=getComputedStyle(element);if(style.visibility!=='visible')continue;
    let text=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim();
    let foregroundStyle=style,placeholder=false;
    if(element.matches('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=color]):not([type=range]):not([type=file]),textarea')){
      text=element.value || element.placeholder;
      if(!element.value&&element.placeholder){foregroundStyle=getComputedStyle(element,'::placeholder');placeholder=true;}
    }
    if(element.matches('select'))text=element.selectedOptions[0]?.textContent || '';
    if(!/[\p{L}\p{N}]/u.test(text))continue;
    const parents=[];for(let node=element;node;node=node.parentElement)parents.unshift(node);
    let background=[255,255,255],gradient=false,translucent=false,hidden=false;
    for(const parent of parents){
      const s=getComputedStyle(parent),opacity=Number(s.opacity);
      if(opacity===0){hidden=true;break;}
      if(opacity<1 || s.filter!=='none')translucent=true;
      const color=rgba(s.backgroundColor);
      if(color[3]===1)gradient=false;
      background=blend(color,background);
      if(s.backgroundImage!=='none')gradient=true;
      for(const pseudo of ['::before','::after']){
        const layer=getComputedStyle(parent,pseudo);
        if(!['none','normal'].includes(layer.content)&&layer.backgroundImage!=='none')gradient=true;
      }
    }
    if(hidden)continue;
    const color=rgba(foregroundStyle.color);
    if(placeholder)color[3]*=Number(foregroundStyle.opacity);
    const foreground=blend(color,background),size=parseFloat(style.fontSize),weight=parseInt(style.fontWeight)||400;
    const threshold=size>=24 || size>=18.66&&weight>=700?3:4.5;
    const item={tag:element.tagName.toLowerCase(),id:element.id,class:element.className,text:text.slice(0,100),foreground:foregroundStyle.color,background:background.map(Math.round),ratio:ratio(foreground,background),threshold};
    if(gradient || translucent)review.push(item);else samples.push(item);
  }
  return {samples,review,failures:samples.filter(item=>item.ratio<item.threshold)};
}
