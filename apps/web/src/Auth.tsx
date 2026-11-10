import React,{useEffect,useState} from 'react';
import {api,setCsrf} from './api';
import Workspace from './Workspace';

export function AuthBoundary({children}:{children:React.ReactNode}) {
  const [user,setUser]=useState<any>(),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[invitation,setInvitation]=useState(''),[register,setRegister]=useState(false);
  const [users,setUsers]=useState<any[]>([]),[invite,setInvite]=useState(''),[admin,setAdmin]=useState(false);
  const [currentPassword,setCurrentPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[security,setSecurity]=useState(false);
  useEffect(()=>{const expired=()=>{setCsrf('');setUser(undefined);setAdmin(false);setInvite('');};window.addEventListener('maa-session-expired',expired);return()=>window.removeEventListener('maa-session-expired',expired);},[]);
  useEffect(()=>{api('auth/me').then(s=>{setCsrf(s.csrf);setUser(s.user);}).catch(()=>{}).finally(()=>setLoading(false));},[]);
  async function submit(e:React.FormEvent) {
    e.preventDefault();setError('');
    try {
      if(register)await api('auth/register','POST',{username,password,invitation});
      const s=await api('auth/login','POST',{username,password});setCsrf(s.csrf);setUser(s.user);setPassword('');setInvitation('');
    }catch(e:any){setError(e.message);}
  }
  async function logout(){await api('auth/logout','POST',{});setCsrf('');setUser(undefined);setAdmin(false);setInvite('');setCurrentPassword('');setNewPassword('');setSecurity(false);}
  if(loading)return <p>正在验证会话…</p>;
  if(!user)return <main><form className="panel" onSubmit={submit}><h1>MAA Manager · {register?'邀请注册':'登录'}</h1>{error&&<p role="alert">{error}</p>}<label>用户名<input autoComplete="username" required value={username} onChange={e=>setUsername(e.target.value)}/></label><label>密码<input autoComplete={register?'new-password':'current-password'} type="password" required minLength={register?12:undefined} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>{register&&<label>邀请令牌<input required value={invitation} onChange={e=>setInvitation(e.target.value)}/></label>}<button type="submit">{register?'注册并登录':'登录'}</button><button type="button" onClick={()=>setRegister(!register)}>{register?'返回登录':'使用邀请注册'}</button></form></main>;
  return <><div className="notice">{user.username} · {user.role==='admin'?'管理员':'成员'} <button onClick={()=>setSecurity(!security)}>账号安全</button><button onClick={()=>void logout().catch(e=>setError(e.message))}>退出登录</button>{user.role==='admin'&&<button onClick={()=>{setAdmin(!admin);void api('admin/users').then(setUsers).catch(e=>setError(e.message));}}>用户管理</button>}</div>{error&&<p role="alert">{error}</p>}{security&&<form className="panel" onSubmit={e=>{e.preventDefault();void api('auth/password','POST',{currentPassword,password:newPassword}).then(()=>{setCurrentPassword('');setNewPassword('');setSecurity(false);setUser(undefined);setCsrf('');}).catch(e=>setError(e.message));}}><h2>账号安全</h2><label>当前密码<input type="password" autoComplete="current-password" maxLength={128} required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label><label>新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><button>修改密码并退出所有会话</button><button type="button" onClick={()=>void api('auth/logout-all','POST',{}).then(()=>{setUser(undefined);setCsrf('');setSecurity(false);setInvite('');}).catch(e=>setError(e.message))}>退出所有设备</button></form>}{admin&&<section className="panel"><h2>用户管理</h2><button onClick={()=>void api('admin/invitations','POST',{}).then(r=>setInvite(r.invitation)).catch(e=>setError(e.message))}>创建 24 小时邀请</button>{invite&&<p>请私下交给朋友（仅显示这一次）：<code>{invite}</code></p>}{users.map(u=><div className="row" key={u.id}>{u.username} · {u.role} · {u.disabled?'已禁用':'正常'}{u.id!==user.id&&<button onClick={()=>void api(`admin/users/${u.id}/disable`,'POST',{disabled:!u.disabled}).then(()=>api('admin/users')).then(setUsers).catch(e=>setError(e.message))}>{u.disabled?'启用':'禁用并撤销会话'}</button>}</div>)}</section>}{user.role==='admin'?children:<Workspace/>}</>;
}
