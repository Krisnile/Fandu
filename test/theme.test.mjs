import test from 'node:test';
import assert from 'node:assert/strict';
import {contrastRatio,onAccent,readableAccent} from '../src/theme.js';

test('theme luminance contrast uses exact thresholds and supports shorthand hex',()=>{
  assert.equal(contrastRatio('#000','#fff'),21);
  assert.equal(contrastRatio('#123456','#123456'),1);
  assert.equal(contrastRatio('#ABC','#ffffff'),contrastRatio('#aabbcc','#ffffff'));
  assert.ok(contrastRatio('#777777','#ffffff')<4.5,'A near miss must not pass by rounding');
  for(const value of ['red','#ffff','#00000000','url(secret)',null])assert.throws(()=>contrastRatio(value,'#ffffff'),/主题颜色无效/);
});
test('fill text chooses a readable black or white for unrestricted custom colors',()=>{
  for(const r of [0,64,128,192,255])for(const g of [0,64,128,192,255])for(const b of [0,64,128,192,255]){
    const color='#'+[r,g,b].map(channel=>channel.toString(16).padStart(2,'0')).join('');
    assert.ok(contrastRatio(color,onAccent(color))>=4.5,color);
  }
});
test('accent text shades toward mode ink without changing the chosen fill',()=>{
  const light=['#f0f7f7','#fbffff','#e4f0f1','#f3fafa'];
  const dark=['#0b171b','#091215','#102329','#193039','#0c1c22'];
  for(const [mode,surfaces] of [['dark',dark],['light',light]]){
    for(const accent of ['#ffffff','#000000','#777777','#4ad9df','#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff']){
      const snapshot=surfaces.slice(),result=readableAccent(accent,surfaces,mode);
      assert.match(result,/^#[a-f0-9]{6}$/);
      assert.equal(readableAccent(accent,surfaces,mode),result);
      for(const background of surfaces)assert.ok(contrastRatio(result,background)>=4.75,`${mode}/${accent}/${background}`);
      assert.deepEqual(surfaces,snapshot);
    }
  }
  assert.equal(readableAccent('#ffffff',dark,'dark'),'#ffffff');
  assert.equal(readableAccent('#000000',light,'light'),'#000000');
});
test('accent text also covers tinted badge surfaces for many custom hues',()=>{
  const toRGB=value=>value.slice(1).match(/../g).map(channel=>parseInt(channel,16));
  for(const [mode,surfaces] of [['dark',['#15101f','#21182e','#2b203b']],['light',['#f8f5ed','#fffdf7','#f1e9d8']]]){
    for(const r of [0,64,128,192,255])for(const g of [0,64,128,192,255])for(const b of [0,64,128,192,255]){
      const color='#'+[r,g,b].map(channel=>channel.toString(16).padStart(2,'0')).join(''),foreground=readableAccent(color,surfaces,mode);
      for(const surface of surfaces){
        for(const amount of [.12,.20]){
          const tinted='#'+toRGB(surface).map((channel,index)=>Math.round(channel*(1-amount)+[r,g,b][index]*amount).toString(16).padStart(2,'0')).join('');
          assert.ok(contrastRatio(foreground,tinted)>=4.75,`${mode}/${color}/${tinted}`);
        }
      }
    }
  }
});
test('accent text refuses invalid or incoherent surface contracts',()=>{
  assert.throws(()=>readableAccent('#fff',[],'light'),/主题表面无效/);
  assert.throws(()=>readableAccent('#fff',['#fff'],'automatic'),/主题表面无效/);
  assert.throws(()=>readableAccent('#777',['#000','#fff'],'light'),/无法提供可读/);
});
