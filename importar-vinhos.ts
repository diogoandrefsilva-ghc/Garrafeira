import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Importação efémera: as imagens não são persistidas; só o resultado revisto
// chega à tabela importacoes. Deploy: supabase functions deploy importar-vinhos
const SB_URL=Deno.env.get("SUPABASE_URL")!;
const SB_SRV=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY=Deno.env.get("GEMINI_FREE_API_KEY")??"";
const API="https://generativelanguage.googleapis.com/v1beta";
const MODELOS=["gemini-2.5-flash","gemini-2.5-flash-lite"];
const MAX_IMAGENS=3, MAX_BASE64=2_400_000;
const LIMITE_GRATIS=Math.max(1,Math.min(20,Number(Deno.env.get("GEMINI_IMPORT_FREE_DAILY_LIMIT")??3)||3));
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const texto=(v:unknown,n:number)=>String(v??"").replace(/\s+/g," ").trim().slice(0,n);
const TIPOS=["Tinto","Branco","Rosé","Espumante","Licoroso","Frisante"];
const ESTILOS=["","Maduro","Verde","Colheita Tardia","Palhete"];
const MENCOES=["","Reserva","Grande Reserva","Garrafeira","Colheita Selecionada","Vinhas Velhas","Superior","Grande Escolha"];
const CLASSIF=["","DOC","Vinho Regional","Vinho"];
function numero(v:unknown,min:number,max:number,casas=0):number|null{
 const n=typeof v==="number"?v:Number(String(v??"").replace(",","."));
 return Number.isFinite(n)&&n>=min&&n<=max?Number(n.toFixed(casas)):null;
}
function ano(v:unknown){const n=numero(v,1900,2100);return n===null?null:Math.round(n);}
function escolha(v:unknown,lista:string[]){const t=texto(v,40).toLocaleLowerCase("pt");return lista.find(x=>x.toLocaleLowerCase("pt")===t)??"";}
function extrairJson(s:string):any|null{
 const t=String(s??"").trim().replace(/^\x60\x60\x60(?:json)?/i,"").replace(/\x60\x60\x60$/,"").trim();
 try{return JSON.parse(t);}catch(_){}
 const inicio=t.indexOf("{");if(inicio<0)return null;
 let nivel=0,em=false,esc=false;
 for(let i=inicio;i<t.length;i++){const c=t[i];if(esc){esc=false;continue;}if(c==="\\"){esc=true;continue;}if(c==='"'){em=!em;continue;}if(em)continue;if(c==="{")nivel++;else if(c==="}"&&--nivel===0){try{return JSON.parse(t.slice(inicio,i+1));}catch(_){return null;}}}
 return null;
}
function normalizar(raw:any):Record<string,unknown>|null{
 const nome=texto(raw?.nome,160);if(nome.length<2)return null;
 const castas=Array.isArray(raw?.castas)?[...new Set(raw.castas.map((x:unknown)=>texto(x,50)).filter((x:string)=>x&&!/^(blend|lote|castas?|várias)$/i.test(x)))].slice(0,12):[];
 const de=ano(raw?.beberDe);let ate=ano(raw?.beberAte);if(de!==null&&ate!==null&&ate<de)ate=null;
 const o:Record<string,unknown>={nome,produtor:texto(raw?.produtor,90),ano:ano(raw?.ano),tipo:escolha(raw?.tipo,TIPOS)||"Tinto",estilo:escolha(raw?.estilo,ESTILOS),regiao:texto(raw?.regiao,60),sub_regiao:texto(raw?.subRegiao,60),mencao:escolha(raw?.mencao,MENCOES),classificacao:escolha(raw?.classificacao,CLASSIF),castas,teor:numero(raw?.teor,4,25,1),estagio_meses:numero(raw?.estagioMeses,0,400),estagio_texto:texto(raw?.estagioTexto,160),notas_prova:texto(raw?.notasProva,600),harmonizacao:texto(raw?.harmonizacao,300),ai_resumo:texto(raw?.resumo,900),beber_de:de,beber_ate:ate,quantidade:Math.round(numero(raw?.quantidade,1,60)??1),aviso:texto(raw?.aviso,300)};
 Object.keys(o).forEach(k=>{const v=o[k];if(v===null||v===""||(Array.isArray(v)&&!v.length))delete o[k];});return o;
}
function prompt(qtd:number){return [
 "És um assistente a transcrever uma garrafeira doméstica a partir de "+qtd+" fotografia(s).",
 "Lê APENAS texto realmente visível em rótulos, caixas, listas manuscritas ou prateleiras. Uma foto pode ter vários vinhos; imagens repetidas podem mostrar duas faces da mesma garrafa. Junta repetições e usa quantidade se vires várias garrafas iguais.",
 "Não pesquisas na internet e não completas dados de memória. Se não se vê, omite. Não inventes produtor, ano, região, castas, teor, tipo ou quantidade. Não cries entradas para menus, preços ou acessórios.",
 "Responde APENAS JSON, sem markdown: {\"vinhos\":[{\"nome\":\"texto visível\",\"produtor\":\"\",\"ano\":2020,\"tipo\":\"Tinto | Branco | Rosé | Espumante | Licoroso | Frisante\",\"estilo\":\"Maduro | Verde | Colheita Tardia | Palhete\",\"regiao\":\"\",\"subRegiao\":\"\",\"mencao\":\"Reserva | Grande Reserva | Garrafeira | Colheita Selecionada | Vinhas Velhas | Superior | Grande Escolha\",\"classificacao\":\"DOC | Vinho Regional | Vinho\",\"castas\":[\"\"],\"teor\":13.5,\"estagioMeses\":18,\"estagioTexto\":\"\",\"notasProva\":\"\",\"harmonizacao\":\"\",\"resumo\":\"\",\"beberDe\":2026,\"beberAte\":2030,\"quantidade\":1,\"aviso\":\"dúvida opcional\"}],\"aviso\":\"observação geral opcional\"}"
 ].join("\n");}
function comLimite(pai:AbortSignal,ms:number){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms),a=()=>c.abort();pai.addEventListener("abort",a,{once:true});return{signal:c.signal,limpar:()=>{clearTimeout(t);pai.removeEventListener("abort",a);}};}
async function ler(imagens:{mime:string,data:string}[],signal:AbortSignal){
 if(!GEMINI_KEY)throw new Error("a importação ainda não está configurada: falta GEMINI_FREE_API_KEY");
 const parts=[{text:prompt(imagens.length)},...imagens.map(i=>({inline_data:{mime_type:i.mime,data:i.data}}))];let ultimo="";
 for(let i=0;i<MODELOS.length;i++){const modelo=MODELOS[i],lim=comLimite(signal,i?28000:72000);try{
   const r=await fetch(API+"/models/"+modelo+":generateContent?key="+GEMINI_KEY,{method:"POST",headers:{"Content-Type":"application/json"},signal:lim.signal,body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{temperature:0,responseMimeType:"application/json",maxOutputTokens:8192}})});
   lim.limpar();if(!r.ok){ultimo="Gemini respondeu "+r.status+": "+(await r.text()).slice(0,240);continue;}
   const d=await r.json(),bruto=(d?.candidates?.[0]?.content?.parts??[]).map((p:any)=>p?.text??"").join(""),raw=extrairJson(bruto),lista=Array.isArray(raw?.vinhos)?raw.vinhos:[];
   return{vinhos:lista.map(normalizar).filter(Boolean).slice(0,40),aviso:texto(raw?.aviso,300),modelo};
 }catch(e){lim.limpar();if(signal.aborted)throw e;ultimo=String((e as Error).message||"a leitura falhou");}}
 throw new Error(ultimo||"o modelo não conseguiu ler as imagens");
}
async function rpc(auth:string,nome:string,body:Record<string,unknown>,signal:AbortSignal){
 const r=await fetch(SB_URL+"/rest/v1/rpc/"+nome,{method:"POST",headers:{apikey:SB_SRV,Authorization:auth,"Content-Type":"application/json","Content-Profile":"garrafeira"},body:JSON.stringify(body),signal});return r.ok?await r.json():null;
}
async function registar(estado:string,detalhe:Record<string,unknown>,quem:string|null){try{await fetch(SB_URL+"/rest/v1/sync_log",{method:"POST",headers:{apikey:SB_SRV,Authorization:"Bearer "+SB_SRV,"Content-Type":"application/json","Content-Profile":"garrafeira",Prefer:"return=minimal"},body:JSON.stringify({origem:"function",acao:"importar-vinhos",estado,quem,detalhe})});}catch(_){}}
async function autorizar(auth:string,gid:number,signal:AbortSignal){
 const u=await fetch(SB_URL+"/auth/v1/user",{headers:{apikey:SB_SRV,Authorization:auth},signal});if(!u.ok)return{ok:false,email:"",plano:"sem_ia"};
 const email=texto((await u.json())?.email,200).toLowerCase();if(!email||await rpc(auth,"is_editor",{},signal)!==true)return{ok:false,email,plano:"sem_ia"};
 const plano=String(await rpc(auth,"plano_ia",{},signal)??"sem_ia"),pode=await rpc(auth,"pode_mexer",{p_gid:gid},signal)===true;
 return{ok:pode&&(plano==="gratis"||plano==="premium"),email,plano};
}
async function quota(auth:string,quem:string,signal:AbortSignal){
 const inicio=new Date().toISOString().slice(0,10)+"T00:00:00.000Z",url=SB_URL+"/rest/v1/importacoes?select=id&quem=eq."+encodeURIComponent(quem)+"&plano_ia=eq.gratis&criado_em=gte."+encodeURIComponent(inicio)+"&limit="+LIMITE_GRATIS;
 const r=await fetch(url,{headers:{apikey:SB_SRV,Authorization:auth,"Content-Profile":"garrafeira"},signal});return r.ok&&(await r.json()).length<LIMITE_GRATIS;
}
async function criar(auth:string,gid:number,qtd:number,signal:AbortSignal){
 const r=await fetch(SB_URL+"/rest/v1/importacoes",{method:"POST",headers:{apikey:SB_SRV,Authorization:auth,"Content-Type":"application/json","Content-Profile":"garrafeira",Prefer:"return=representation"},body:JSON.stringify({garrafeira_id:gid,pedido:{quantidade_imagens:qtd}}),signal});
 if(!r.ok)throw new Error("não foi possível criar a importação");const id=(await r.json())?.[0]?.id;if(typeof id!=="number")throw new Error("a importação não devolveu identificador");return id;
}
async function fechar(id:number,quem:string,patch:Record<string,unknown>){await fetch(SB_URL+"/rest/v1/importacoes?id=eq."+id+"&quem=eq."+encodeURIComponent(quem),{method:"PATCH",headers:{apikey:SB_SRV,Authorization:"Bearer "+SB_SRV,"Content-Type":"application/json","Content-Profile":"garrafeira",Prefer:"return=minimal"},body:JSON.stringify(patch)});}

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"Content-Type":"application/json"}});
 if(req.method!=="POST")return json({error:"método não permitido"},405);
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),45000);let quem="";
 try{
  const body=await req.json().catch(()=>({})),gid=Number(body?.garrafeiraId),recebidas=Array.isArray(body?.imagens)?body.imagens:[];
  if(!Number.isSafeInteger(gid)||gid<1)return json({error:"falta a garrafeira"},400);
  if(!recebidas.length||recebidas.length>MAX_IMAGENS)return json({error:"escolhe entre 1 e "+MAX_IMAGENS+" imagens"},400);
  const imagens:{mime:string,data:string}[]=[];
  for(const x of recebidas){const mime=String(x?.mime??"").toLowerCase(),data=String(x?.data??"").replace(/\s/g,"");if(!/^(image\/jpeg|image\/png|image\/webp)$/.test(mime)||data.length<100||data.length>MAX_BASE64||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return json({error:"uma das imagens não é válida ou ficou demasiado grande"},400);imagens.push({mime,data});}
  const token=req.headers.get("Authorization")??"",auth=await autorizar(token,gid,ctrl.signal);quem=auth.email;
  if(!auth.ok)return json({error:"não autorizado para importar nesta garrafeira"},403);
  if(auth.plano==="gratis"&&!(await quota(token,quem,ctrl.signal)))return json({error:"atingiste o limite diário de "+LIMITE_GRATIS+" importações grátis — tenta amanhã ou pede acesso premium"},429);
  const id=await criar(token,gid,imagens.length,ctrl.signal);await registar("pedido",{id,garrafeira_id:gid,imagens:imagens.length,plano:auth.plano},quem);
  EdgeRuntime.waitUntil((async()=>{const proc=new AbortController(),t=setTimeout(()=>proc.abort(),105000);try{const resultado=await ler(imagens,proc.signal);await fechar(id,quem,{estado:"concluido",resultado});await registar("ok",{id,vinhos:resultado.vinhos.length,modelo:resultado.modelo},quem);}catch(e){const erro=texto((e as Error).message||"a importação falhou",400);await fechar(id,quem,{estado:"erro",erro});await registar("erro",{id,passo:"gemini",erro},quem);}finally{clearTimeout(t);}})());
  return json({id,estado:"pendente"});
 }catch(e){const erro=texto((e as Error).message||"erro inesperado",300);await registar("erro",{passo:"entrada",erro},quem||null);return json({error:erro},500);}finally{clearTimeout(timer);}
});

