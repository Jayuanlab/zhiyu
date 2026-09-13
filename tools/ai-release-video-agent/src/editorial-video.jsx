import React from 'react';
import {AbsoluteFill, Composition, Sequence, OffthreadVideo, staticFile, interpolate, registerRoot, useCurrentFrame, useVideoConfig} from 'remotion';

const palettes = ['#66ead0','#a99aff','#ffb67c'];
function Shot({shot, index}) {
  const f = useCurrentFrame(); const {fps} = useVideoConfig();
  const d = shot.display; const accent = shot.shot?.accent || palettes[index % palettes.length];
  const background=shot.shot?.background || '#111621', foreground=shot.shot?.foreground || '#f6f7fb';
  const progress=Math.min(1,f/Math.max(1,shot.frames-1));
  const motion=shot.shot?.motion;
  const scale=motion==='push-in'?1+progress*.12:motion==='pull-out'?1.12-progress*.12:motion==='pan-left'?1.1:1;
  const opacity=shot.shot?.transition==='fade'?Math.max(0,Math.min(1,f/8,(shot.frames-1-f)/8)):1;
  const enter = delay => ({opacity: interpolate(f,[delay,delay+12],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}),transform:`translateY(${interpolate(f,[delay,delay+16],[35,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}px)`});
  const cue = i => shot.cueFrames?.[i] ?? i*shot.frames/d.items.length;
  const active = d.items.reduce((a,_,i)=>f>=cue(i)?i:a,0);
  const card = {padding:24, borderRadius:20, border:'1px solid #ffffff25', background:'#ffffff0a', lineHeight:1.5};
  if(shot.shot?.mode==='generated'||shot.shot?.mode==='title')return <AbsoluteFill style={{background,color:foreground,fontFamily:'Microsoft YaHei, sans-serif',opacity}}>
    {shot.media&&<AbsoluteFill style={{transform:`scale(${scale}) translateX(${motion==='pan-left'?3-progress*6:0}%)`}}><OffthreadVideo src={staticFile(shot.media.filename)} muted style={{width:'100%',height:'100%',objectFit:'cover'}}/></AbsoluteFill>}
    {shot.media&&<AbsoluteFill style={{background:'linear-gradient(transparent 45%,#000000c9)'}}/>}
    <div style={{position:'absolute',left:56,right:56,top:shot.media?'65%':'33%',...enter(0)}}><div style={{height:5,width:75,background:accent,marginBottom:28}}/><h1 style={{fontSize:shot.media?44:76,lineHeight:1.3,margin:0,color:shot.media?'white':foreground}}>{d.title}</h1></div>
    {shot.media&&<div style={{position:'absolute',top:50,right:40,fontSize:19,color:'white',background:'#0009',padding:10}}>AI 生成示意</div>}
    {d.source&&<div style={{position:'absolute',bottom:210,left:56,right:56,fontSize:18}}>{d.source}</div>}
  </AbsoluteFill>;
  return <AbsoluteFill style={{background,color:foreground,fontFamily:'Microsoft YaHei, sans-serif',padding:'75px 56px',opacity}}>
    <div style={{position:'absolute',width:600,height:600,top:-350,right:-230,borderRadius:'50%',background:accent,filter:'blur(130px)',opacity:.18}}/>
    <div style={{fontSize:20,letterSpacing:3,color:accent}}>ZHIYU / 知识速览 <span style={{float:'right',color:'#7f8a9d'}}>{String(index+1).padStart(2,'0')}</span></div>
    <h1 style={{fontSize:d.title.length>16?45:56,lineHeight:1.25,margin:'70px 0 35px',...enter(0)}}>{d.title}</h1>
    <div style={{width:70,height:5,background:accent,marginBottom:32}}/>
    {d.kind==='comparison' ? <div style={{display:'flex',gap:20}}>{[d.left,d.right].map((side,i)=><div key={i} style={{...card,width:'50%',...enter(cue(i))}}><h2 style={{fontSize:30,color:i?accent:'#b1b9c8'}}>{side.title}</h2>{side.items.map((s,j)=><p key={j} style={{fontSize:25,...enter(cue(i)+j*8)}}>{s}</p>)}</div>)}</div> :
      <div style={{display:'grid',gap:18}}>{d.items.map((s,i)=><React.Fragment key={i}>{d.kind==='process'&&i>0&&<div style={{color:accent,fontSize:28,marginLeft:30,...enter(cue(i))}}>↓</div>}<div style={{...card,...enter(cue(i)),borderColor:active===i?accent:'#ffffff25',background:active===i?`${accent}13`:'#ffffff07',display:'flex',gap:20,fontSize:s.length>55?25:31}}><span style={{color:accent,fontSize:22,minWidth:28}}>{String(i+1).padStart(2,'0')}</span><span>{s}</span></div></React.Fragment>)}</div>}
    <div style={{position:'absolute',bottom:195,left:56,right:56,fontSize:18,color:'#8e9aad'}}>{d.source}</div>
    <div style={{position:'absolute',bottom:65,left:56,right:56,height:3,background:'#ffffff20'}}><div style={{height:'100%',width:`${100*f/shot.frames}%`,background:accent}}/></div>
  </AbsoluteFill>;
}
function Video({plan}) {
  const frame=useCurrentFrame(); const {fps}=useVideoConfig();
  const caption=plan.captions.find(c=>frame/fps>=c.start&&frame/fps<c.end);
  return <AbsoluteFill>{plan.shots.map((shot,i)=><Sequence key={shot.id} from={shot.from} durationInFrames={shot.frames}><Shot shot={shot} index={i}/></Sequence>)}
    {plan.disclosure&&<div style={{position:'absolute',bottom:168,left:56,right:56,color:'#8e9aad',fontFamily:'Microsoft YaHei, sans-serif',fontSize:16}}>{plan.disclosure}</div>}
    {caption&&<div style={{position:'absolute',bottom:105,left:45,right:45,textAlign:'center',fontFamily:'Microsoft YaHei, sans-serif',fontSize:30,lineHeight:1.5,color:'white',fontWeight:600}}><span style={{background:'#080c14e8',padding:'8px 14px',boxDecorationBreak:'clone'}}>{caption.text}</span></div>}
  </AbsoluteFill>;
}
registerRoot(()=> <Composition id="KnowledgeVideo" component={Video} width={720} height={1280} fps={25} durationInFrames={25} defaultProps={{plan:{shots:[],captions:[]}}} calculateMetadata={({props})=>({durationInFrames:props.plan.frames})}/>);
