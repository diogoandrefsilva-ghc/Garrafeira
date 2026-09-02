/* Garrafeira — toda a lógica da app.
   Carrega como <script src> NORMAL, não module: há onclick="…" no HTML e no
   HTML que este ficheiro gera, por isso as funções TÊM de ser globais.

   Secções (procura pelo título, não leias o ficheiro todo):
     Sessão Supabase · Permissões · DB (carregar) · Índices e cálculos ·
     Navegação · Estatísticas · Filtros · Lista · Mapa dos locais ·
     Consumidos · Página do vinho · Modal editar/novo · Consumir garrafa ·
     Modal da garrafa · IA (procurar informação) · Auth (Supabase) ·
     Utilizadores (admin) · Locais (config) · Exportar · Diagnóstico · Init
*/

/* ── SESSÃO SUPABASE ───────────────────────────────────────────────────
   Mesmo projeto do Goals/FestasBV/SplitBill, schema `garrafeira`. O padrão é
   o mesmo: sessão em localStorage, refresh automático do access token
   (expira em ~1h), e Accept/Content-Profile a escolher o schema — NUNCA no
   URL, que é erro comum e dá 404 sem explicação. */
const SB_URL='https://gjweqwfbnkgnibhajldc.supabase.co';
// Chave `anon`, pública por design (é o que o browser tem de ter para falar
// com o PostgREST). Está protegida por RLS + login — não é bug nem risco,
// não a "corrijas" nem a escondas.
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';
const SESSION_KEY='garrafeira_sb_session';
// Só o valor de arranque. Quem manda é a linha `admin_email` da tabela
// `garrafeira.config`, lida em carregar() — é isso que deixa passar a app ao
// Barrona sem tocar em código. A UI usa-o para saber que botões mostrar; a
// decisão a sério é sempre da RLS (garrafeira.is_admin()).
let ADMIN_EMAIL='diogo.andre.f.silva@gmail.com';
// O DONO da conta Supabase — este, sim, é fixo e não muda quando a app
// passa para outro admin (`admin_email` na BD). A password temporária e o
// diagnóstico mexem na CONTA Supabase (que continua a ser minha), não na
// garrafeira, por isso ficam presos a este email e não ao admin de cada vez.
const SUPABASE_DONO_EMAIL='diogo.andre.f.silva@gmail.com';
function souDono(){
  return !!(_sbSession&&_sbSession.user&&
    String(_sbSession.user.email||'').toLowerCase()===SUPABASE_DONO_EMAIL.toLowerCase());
}
let _sbSession=null;

function sbHeaders(extra={}){
  return Object.assign({
    'Content-Type':'application/json',
    'apikey':SB_KEY,
    'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`,
    'Accept-Profile':'garrafeira',
    'Content-Profile':'garrafeira'
  },extra);
}
function sbSaveSession(s){_sbSession=s;localStorage.setItem(SESSION_KEY,JSON.stringify(s));}

let _refreshing=null;
async function sbRefresh(){
  if(!_sbSession||!_sbSession.refresh_token)return false;
  if(_refreshing)return _refreshing;
  _refreshing=(async()=>{
    try{
      const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
        method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:_sbSession.refresh_token})
      });
      if(!r.ok)return false;
      const d=await r.json();
      sbSaveSession({
        access_token:d.access_token,
        refresh_token:d.refresh_token||_sbSession.refresh_token,
        expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
        user:d.user||_sbSession.user
      });
      return true;
    }catch(e){return false;}
  })();
  const ok=await _refreshing;_refreshing=null;return ok;
}
function tokenQuaseExpirado(){
  if(!_sbSession)return false;
  if(!_sbSession.expires_at)return true;
  return (_sbSession.expires_at-Date.now()/1000)<120;
}
async function sbFetch(url,opt){
  if(_sbSession&&_sbSession.refresh_token&&tokenQuaseExpirado())await sbRefresh();
  opt=opt||{};
  opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`});
  let r=await fetch(url,opt);
  if(r.status===401&&_sbSession&&_sbSession.refresh_token){
    if(await sbRefresh()){
      opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession.access_token}`});
      r=await fetch(url,opt);
    }
  }
  return r;
}
// O PostgREST recusa objetos com colunas diferentes na mesma inserção em
// lote — um POST de várias garrafas de uma vez, por exemplo, rebentava se
// nem todas tivessem os mesmos campos preenchidos.
function sbRowsUniformes(rows){
  const plain=o=>o&&typeof o==='object'&&!Array.isArray(o);
  if(!Array.isArray(rows)||rows.length<2||!rows.every(plain))return rows;
  const keys=[];rows.forEach(r=>Object.keys(r).forEach(k=>{if(!keys.includes(k))keys.push(k);}));
  if(rows.every(r=>Object.keys(r).length===keys.length))return rows;
  return rows.map(r=>{const o={};keys.forEach(k=>o[k]=r[k]!==undefined?r[k]:null);return o;});
}
async function sbReq(method,path,body,extra){
  const opt={method,headers:sbHeaders(extra||{})};
  if(method==='POST')body=sbRowsUniformes(body);
  if(body!==undefined)opt.body=JSON.stringify(body);
  const r=await sbFetch(`${SB_URL}/rest/v1/${path}`,opt);
  if(!r.ok){let m='HTTP '+r.status;try{const j=await r.json();m=j.message||j.hint||m;}catch(_){}throw new Error(m);}
  const tx=await r.text();
  return tx?JSON.parse(tx):null;
}
// Chamar uma função SQL (RPC). O `Content-Profile` do sbHeaders é o que a põe
// no schema certo.
async function sbRpc(nome,args){
  return sbReq('POST',`rpc/${nome}`,args||{});
}

/* ── PERMISSÕES ────────────────────────────────────────────────────────
   Três níveis, iguais aos de db/policies.sql:
     · quem tem acesso  vê tudo
     · editor           mexe em vinhos/garrafas/locais
     · admin            manda em quem tem acesso e em quem é editor
   `isReadOnly` é "não posso editar" (não "não sou admin"): numa garrafeira
   de casa faz sentido haver quem dê saída a uma garrafa sem por isso mandar
   na lista de utilizadores. */
let isReadOnly=true, EU={email:'',pode_editar:false};
function isAdmin(){
  return !!(_sbSession&&_sbSession.user&&
    String(_sbSession.user.email||'').toLowerCase()===String(ADMIN_EMAIL||'').toLowerCase());
}
function podeEditar(){return isAdmin()||!!EU.pode_editar;}
function aplicarPermissoes(){
  isReadOnly=!podeEditar();
  document.body.classList.toggle('readonly',isReadOnly);
  document.body.classList.toggle('naoadmin',!isAdmin());
  document.body.classList.toggle('naodono',!souDono());
}
// Guarda de UI. Devolve true quando a ação deve parar aqui.
function roGuard(){
  if(!isReadOnly)return false;
  toast('🔒 Não tens permissão para editar a garrafeira',1);
  return true;
}

/* ── DB ────────────────────────────────────────────────────────────────
   Não há salvar() nenhum: cada mutação é o POST/PATCH/DELETE da própria
   linha, atualiza o `db` local e re-renderiza. O padrão para um campo novo
   é sempre o mesmo — optimista no `db`, try/catch à volta do sbReq, e
   desfaz o `db` se a rede falhar.
   Os `id` são REAIS da BD (lidos de volta com Prefer: return=representation),
   nunca Date.now(). */
let db={locais:[],vinhos:[],garrafas:[],castas:[],config:{}};

async function carregar(){
  const [locais,vinhos,garrafas,castas,vc,cfg,eu]=await Promise.all([
    sbReq('GET','locais?select=*&order=ordem.asc,nome.asc'),
    sbReq('GET','vinhos?select=*&order=nome.asc'),
    sbReq('GET','garrafas?select=*&order=id.asc'),
    sbReq('GET','castas?select=*&order=nome.asc'),
    sbReq('GET','vinho_castas?select=*'),
    sbReq('GET','config?select=*'),
    sbReq('GET',`allowed_users?select=email,nome,pode_editar&email=eq.${encodeURIComponent(_sbSession.user.email)}`)
  ]);
  db.locais=locais||[];db.vinhos=vinhos||[];db.garrafas=garrafas||[];db.castas=castas||[];
  db.config={};(cfg||[]).forEach(c=>db.config[c.chave]=c.valor);
  if(db.config.admin_email)ADMIN_EMAIL=db.config.admin_email;

  // O admin pode não estar na sua própria lista (is_allowed() dá-lhe acesso
  // à mesma) — nesse caso não vem linha nenhuma e ele fica editor por ser
  // admin, que é o que a BD também decide.
  const minha=(eu||[])[0]||null;
  EU={email:_sbSession.user.email,pode_editar:minha?!!minha.pode_editar:false,nome:minha?minha.nome:''};

  // castas por vinho: junta-se aqui, no cliente, em vez de pedir ao
  // PostgREST um select com relação embebida. O dataset é pequeno e assim
  // não se depende de o PostgREST ter descoberto a FK.
  const nomeCasta={};db.castas.forEach(c=>nomeCasta[c.id]=c.nome);
  const porVinho={};(vc||[]).forEach(l=>{
    (porVinho[l.vinho_id]=porVinho[l.vinho_id]||[]).push(nomeCasta[l.casta_id]);
  });
  db.vinhos.forEach(v=>{v.castas=(porVinho[v.id]||[]).filter(Boolean).sort((a,b)=>a.localeCompare(b,'pt'));});

  await detetarImagem();
  await detetarLinks();
  await detetarAtualizado();
  await assinarImagens();
  reindexar();
  aplicarPermissoes();
}

/* `vinhos.imagem_url` é uma coluna NOVA (ver db/schema.sql). A app tem de
   funcionar antes de alguém correr o ALTER TABLE no Supabase: se a coluna
   não existir, o campo não aparece no formulário e não vai no PATCH — que
   de outra forma rebentava com 400 em TODAS as gravações. */
let TEM_IMAGEM=false, TEM_IMAGEM_PATH=false;
async function detetarImagem(){
  if(db.vinhos.length){
    TEM_IMAGEM=('imagem_url' in db.vinhos[0]);
    TEM_IMAGEM_PATH=('imagem_path' in db.vinhos[0]);
    return;
  }
  try{await sbReq('GET','vinhos?select=imagem_url&limit=1');TEM_IMAGEM=true;}
  catch(e){TEM_IMAGEM=false;}
  try{await sbReq('GET','vinhos?select=imagem_path&limit=1');TEM_IMAGEM_PATH=true;}
  catch(e){TEM_IMAGEM_PATH=false;}
}

// `vinhos.links` é coluna NOVA (ver db/schema.sql) — mesmo padrão do
// `detetarImagem()`: a app tem de funcionar antes de alguém correr o ALTER
// TABLE no Supabase.
let TEM_LINKS=false;
async function detetarLinks(){
  if(db.vinhos.length){TEM_LINKS=('links' in db.vinhos[0]);return;}
  try{await sbReq('GET','vinhos?select=links&limit=1');TEM_LINKS=true;}
  catch(e){TEM_LINKS=false;}
}

// `vinhos.atualizado_em` é coluna NOVA (ver db/schema.sql) — mesmo padrão.
// Enquanto a migração não corre, `guardarVinho()` não a manda no PATCH/POST
// e a página do vinho usa `criado_em` como recurso.
let TEM_ATUALIZADO=false;
async function detetarAtualizado(){
  if(db.vinhos.length){TEM_ATUALIZADO=('atualizado_em' in db.vinhos[0]);return;}
  try{await sbReq('GET','vinhos?select=atualizado_em&limit=1');TEM_ATUALIZADO=true;}
  catch(e){TEM_ATUALIZADO=false;}
}

/* ── ÍNDICES E CÁLCULOS ────────────────────────────────────────────── */
let IDXV={}, IDXL={}, GARV={};
function reindexar(){
  IDXV={};db.vinhos.forEach(v=>IDXV[v.id]=v);
  IDXL={};db.locais.forEach(l=>IDXL[l.id]=l);
  GARV={};db.garrafas.forEach(g=>(GARV[g.vinho_id]=GARV[g.vinho_id]||[]).push(g));
}
const naGarrafeira=g=>g.estado==='na_garrafeira';
function garrafasDe(vinhoId,soAtivas){
  const l=GARV[vinhoId]||[];
  return soAtivas?l.filter(naGarrafeira):l;
}
function stockDe(vinhoId){return garrafasDe(vinhoId,true).length;}

/* Monocasta vs. várias castas — o requisito, calculado e não guardado.
   Uma coluna na BD ficava dessincronizada assim que alguém editasse as
   castas; a contagem nunca fica. */
function castaLabel(v){
  const n=(v.castas||[]).length;
  if(n===0)return '';
  return n===1?'Monocasta':'Várias castas';
}
function nomeLocal(id){return (IDXL[id]||{}).nome||'Sem local';}

/* A IMAGEM DE CADA VINHO.
   Se o vinho tiver `imagem_url` (foto do rótulo), é essa que manda. Sem
   ela — que é o caso da esmagadora maioria — desenha-se a garrafa: o vidro
   toma a cor do TIPO, o rótulo leva o ano. Foi o que substituiu a barrinha
   de cor à esquerda do cartão: aquela barra dizia o local (informação que
   ninguém lia numa risca de 5px) e a imagem diz o que a coisa é ao longe.
   O local passou para o pip colorido do rodapé, ao lado do sítio escrito.

   É SVG inline e não <img>: não há build nem pasta de imagens nesta app, e
   assim a garrafa não custa um pedido à rede nem falha offline. */
const VIDRO={Tinto:'#5e1226',Branco:'#8b9a45','Rosé':'#cd7d95',
  Espumante:'#3a5140',Licoroso:'#7b4213',Frisante:'#7d9b6e'};
function corVinho(v){return VIDRO[(v||{}).tipo]||VIDRO.Tinto;}
function garrafaSVG(v,mini){
  const c=corVinho(v);
  const cap=(v.tipo==='Espumante'||v.tipo==='Licoroso')?'#a9832f':'#33202a';
  const ano=v.ano?String(v.ano):'';
  return `<svg viewBox="0 0 40 74" aria-hidden="true" focusable="false">
    <rect x="14.5" y="1" width="11" height="8" rx="2" fill="${cap}"/>
    <path d="M15.5 4h9v11.5q0 3.5 4.6 7Q33 27 33 34.5V64q0 6-6 6H13q-6 0-6-6V34.5q0-7.5 3.9-12Q15.5 19 15.5 15.5z" fill="${c}"/>
    <rect x="17" y="6" width="2.4" height="12" rx="1.2" fill="#fff" opacity=".22"/>
    ${mini?'':`<rect x="9.5" y="43" width="21" height="17" rx="2" fill="#f8f2e6"/>
    <rect x="9.5" y="43" width="21" height="3" fill="${c}" opacity=".6"/>
    <text x="20" y="56" text-anchor="middle" font-family="Fraunces,Georgia,serif" font-size="9.5"
      fill="#4e1228">${esc(ano)}</text>`}
  </svg>`;
}
/* QUAL imagem é que se mostra. Há duas origens e a ordem é sempre esta:
     1. `imagem_path` — a MINHA foto, no bucket privado. Ganha sempre: quem
        tem a garrafa na mão sabe melhor do que a IA qual é o rótulo.
     2. `imagem_url` — o link que a procura encontrou numa loja.
     3. nenhuma — fica a garrafa desenhada.
   Apagar a minha faz reaparecer a de baixo; ela nunca é deitada fora. */
const BUCKET='garrafeira-rotulos';
let IMG_ASSINADA={};        // vinho_id -> URL assinado (válido umas horas)
function imagemDe(v){
  if(!v)return '';
  if(String(v.imagem_path||'').trim()&&IMG_ASSINADA[v.id])return IMG_ASSINADA[v.id];
  return String(v.imagem_url||'').trim();
}
function imagemPropria(v){return !!String((v||{}).imagem_path||'').trim();}

/* O bucket é PRIVADO, por isso um <img src> não lhe chega com o JWT — o
   browser não manda cabeçalhos numa imagem. A saída são links assinados:
   pedem-se TODOS de uma vez ao carregar (um pedido, não um por vinho) e
   duram uma semana, que é muito mais do que uma sessão. */
async function assinarImagens(){
  IMG_ASSINADA={};
  const comFoto=db.vinhos.filter(imagemPropria);
  if(!comFoto.length)return;
  try{
    const r=await sbFetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({expiresIn:604800,paths:comFoto.map(v=>v.imagem_path)})
    });
    if(!r.ok)return;
    const lista=await r.json();
    // A API já devolveu isto como `signedURL` e como `signedUrl` conforme a
    // versão, e o `path` ora vem com barra à frente ora sem. Em vez de
    // apostar numa forma, aceitam-se as duas e, se o `path` não bater,
    // casa-se pela ORDEM — a resposta vem na ordem em que se pediu.
    (lista||[]).forEach((x,i)=>{
      const url=x&&(x.signedURL||x.signedUrl);
      if(!url)return;
      const caminho=String((x&&x.path)||'').replace(/^\/+/,'');
      const v=comFoto.find(w=>w.imagem_path===caminho)||comFoto[i];
      if(v)IMG_ASSINADA[v.id]=url.startsWith('http')?url:`${SB_URL}/storage/v1${url.startsWith('/')?'':'/'}${url}`;
    });
  }catch(e){/* sem link assinado fica a foto da net, ou a garrafa desenhada */}
}

// A miniatura do cartão: garrafa desenhada por baixo, foto por cima quando
// existe. Se a foto falhar (link partido), o `onerror` tira-a e fica a
// garrafa — nunca um quadrado vazio.
function vinhoThumb(v,qtd){
  const img=imagemDe(v);
  return `<div class="vc-thumb">${garrafaSVG(v)}
    ${img?`<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">`:''}
    ${qtd>1?`<span class="vc-qtd">\u00d7${qtd}</span>`:''}</div>`;
}

// "Nível 2" tem de vir antes de "Nível 10" — a ordenação alfabética punha o
// 10 primeiro, e o mapa da garrafeira ficava com os níveis baralhados.
function ordPrateleira(a,b){
  const num=s=>{const m=String(s).match(/(\d+)/);return m?parseInt(m[1],10):null;};
  const na=num(a),nb=num(b);
  if(na!==null&&nb!==null&&na!==nb)return na-nb;
  return String(a).localeCompare(String(b),'pt',{numeric:true});
}
function ondeEsta(g){
  const p=[nomeLocal(g.local_id)];
  if(g.prateleira)p.push(g.prateleira);
  if(g.lugar)p.push('lugar '+g.lugar);
  return p.join(' · ');
}

/* Está no ponto de beber? Usa a janela que a IA trouxe (beber_de/beber_ate),
   que vem em ANOS. Sem janela não se inventa nada — devolve ''. */
function janelaBeber(v){
  if(!v.beber_de&&!v.beber_ate)return '';
  const y=new Date().getFullYear();
  if(v.beber_ate&&y>v.beber_ate)return 'passou';
  if(v.beber_de&&y<v.beber_de)return 'cedo';
  return 'ponto';
}
const JANELA_TXT={ponto:'🍷 No ponto',cedo:'⏳ Ainda cedo',passou:'⚠️ Já passou'};

/* ── UTILITÁRIOS ───────────────────────────────────────────────────── */
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Para valores que vão dentro de onclick="…('…')": além do HTML, escapa a
// plica e a barra, senão um vinho chamado "Clefs D'or" parte o atributo.
function escJs(s){return esc(String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"));}
const hoje=()=>new Date().toISOString().slice(0,10);
function dataPT(d){
  if(!d)return '';
  const [a,m,x]=String(d).slice(0,10).split('-');
  return `${x}/${m}/${a}`;
}
// "AAAA-MM-DD hh:mm", na hora de quem está a ver (os `timestamptz` vêm em
// UTC). Aqui a hora conta — é para dizer quando é que se gastou a procura.
function dataHoraLocal(iso){
  if(!iso)return '';
  const d=new Date(iso);
  if(isNaN(d))return String(iso);
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function eur(v){
  if(v==null||v==='')return '';
  return Number(v).toLocaleString('pt-PT',{style:'currency',currency:'EUR',maximumFractionDigits:2});
}
// Sem cêntimos, para os cards e para os totais: "1620 €" cabe onde
// "1 620,00 €" não cabia, e a precisão ao cêntimo num valor ESTIMADO era
// uma exatidão a fingir.
function eur0(v){
  if(v==null||v==='')return '';
  return Number(v).toLocaleString('pt-PT',{style:'currency',currency:'EUR',maximumFractionDigits:0});
}
function num(v){const n=parseFloat(String(v).replace(',','.'));return isNaN(n)?null:n;}
function inteiro(v){const n=parseInt(String(v),10);return isNaN(n)?null:n;}
function estrelas(n){return n?'★'.repeat(n)+'☆'.repeat(5-n):'';}
// Sem acentos e em minúsculas — a procura tem de encontrar "Bacalhoa" quando
// se escreve "bacalhôa" e vice-versa.
function chave(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}

let _toastT=null;
function toast(msg,erro){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.toggle('err',!!erro);t.classList.add('on');
  clearTimeout(_toastT);_toastT=setTimeout(()=>t.classList.remove('on'),erro?4200:2600);
}
function abrirModal(id){document.getElementById(id).classList.add('on');}
function fecharModal(id){
  const el=document.getElementById(id);
  if(!el)return;
  el.classList.remove('on');
  // A página do vinho tem um passo próprio na história do browser (é o que
  // faz o "voltar" do telemóvel fechá-la em vez de sair da app). Sair por
  // aqui tem de o gastar, senão ficava um voltar que não fazia nada.
  if(id==='modal-vinho')pgSairHistoria();
}
// Fechar tocando no fundo (mas não ao arrastar de dentro para fora).
// A página do vinho não entra: aí o "fundo" são as margens da folha, e
// numa página ninguém espera sair por lhe tocar ao lado.
document.addEventListener('click',e=>{
  if(e.target.classList&&e.target.classList.contains('modal')&&!e.target.classList.contains('pagina'))
    fecharModal(e.target.id);
});

/* ── NAVEGAÇÃO ─────────────────────────────────────────────────────── */
let tabAtiva='garrafeira';
const ORDEM_TABS=['garrafeira','detalhe','locais','consumidos','cfg'];
function tab(nome,btn){
  tabAtiva=nome;
  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('on'));
  document.getElementById('s-'+nome).classList.add('on');
  document.querySelectorAll('.itabs .it').forEach(b=>b.classList.remove('on'));
  if(btn)btn.classList.add('on');
  try{localStorage.setItem('gf_tab',nome);}catch(e){}
  if(nome==='garrafeira')renderResumo();
  if(nome==='detalhe'||nome==='locais'){posicionarFiltros(nome);renderFiltrados();}
  if(nome==='consumidos')renderConsumidos();
  if(nome==='cfg')renderCfg();
  window.scrollTo({top:0,behavior:'instant'});
}
function restaurarTab(){
  let t=null;try{t=localStorage.getItem('gf_tab');}catch(e){}
  if(!t||t==='garrafeira')return;
  const bts=document.querySelectorAll('.itabs .it');
  const i=ORDEM_TABS.indexOf(t);
  if(i>0&&bts[i])tab(t,bts[i]);
}
// A procura é UM nó só (o mesmo <input>, o mesmo estado), que se muda de
// sítio consoante o separador — não duas cópias com ids repetidos. Fica em
// Detalhe por defeito no HTML; ao entrar em Locais sobe para lá, e volta
// quando se regressa a Detalhe.
function posicionarFiltros(nome){
  const f=document.getElementById('filtros');
  if(!f)return;
  if(nome==='detalhe'){
    const box=document.getElementById('detalhe-grupos');
    if(box&&f.nextSibling!==box)box.parentNode.insertBefore(f,box);
  }else if(nome==='locais'){
    const box=document.getElementById('mapa');
    if(box&&f.nextSibling!==box)box.parentNode.insertBefore(f,box);
  }
}

/* ── RESUMO (ecrã inicial) ─────────────────────────────────────────
   Só quatro números, de propósito — nada de painel cheio ao estilo do
   Goals. Três deles abrem, ao tocar, a contagem por casta/região; tocar
   numa linha dessa contagem mostra os vinhos. Um "acordeão" de dois
   níveis, sem modal nenhum — os dados já estão todos em memória. */
let RESUMO_ABERTO=null;   // 'mono' | 'regiao' | 'casta' | null
let RESUMO_DRILL=null;    // o nome escolhido dentro do card aberto, ou null

function contarPor(lista,campoFn){
  const m=new Map();
  lista.forEach(v=>{
    (campoFn(v)||[]).forEach(k=>{
      if(!k)return;
      m.set(k,(m.get(k)||0)+1);
    });
  });
  return [...m.entries()].map(([nome,n])=>({nome,n}))
    .sort((a,b)=>b.n-a.n||a.nome.localeCompare(b.nome,'pt'));
}
function resumoToggle(qual){
  RESUMO_ABERTO=RESUMO_ABERTO===qual?null:qual;
  RESUMO_DRILL=null;
  renderResumo();
}
function resumoDrill(qual,valor){
  RESUMO_ABERTO=qual;RESUMO_DRILL=valor;
  renderResumo();
}
function resumoVoltar(){RESUMO_DRILL=null;renderResumo();}
function resumoFechar(){RESUMO_ABERTO=null;RESUMO_DRILL=null;renderResumo();}

// Um card da grelha, no formato de sempre (.sc, com a barra de cor à
// esquerda). Com `id` fica clicável e ganha o chevron; sem `id` é só um
// número (o card dos Vinhos).
function scCard(cor,label,valor,sub,id){
  const aberto=id&&RESUMO_ABERTO===id;
  return `<div class="sc ${cor}${id?' sc-click':''}${aberto?' open':''}"${id?` onclick="resumoToggle('${id}')"`:''}>
    ${id?'<div class="sc-chev">▾</div>':''}
    <div class="sc-l">${esc(label)}</div>
    <div class="sc-v">${valor}</div>
    <div class="sc-s">${esc(sub)}</div>
  </div>`;
}
// Os dois cards DOURADOS ("Região preferida", "Casta preferida") — a região
// e a casta com mais vinhos na garrafeira agora. Tocam no mesmo painel de
// sempre (resumoDrill), já aberto na linha certa: são um atalho para a
// pergunta mais óbvia, não uma contagem nova.
function scCardFav(rotulo,nome,sub,qual){
  return `<div class="sc sc-fav" onclick="resumoDrill('${qual}','${escJs(nome)}')">
    <div class="sc-l">${esc(rotulo)}</div>
    <div class="sc-fav-nome">${esc(nome)}</div>
    <div class="sc-s">${esc(sub)}</div>
  </div>`;
}
/* O painel que abre por baixo da grelha. Dois estados: a contagem
   (casta a casta, região a região) e, depois de se tocar numa linha, os
   vinhos dessa linha.

   O que mudou: o "voltar" era um link azul solto no meio do painel e não
   havia forma de FECHAR sem ir outra vez ao card lá em cima. Agora o
   painel tem barra própria — ‹ voltar à esquerda, a migalha do sítio onde
   se está no meio, e o ✕ que fecha tudo à direita. O card que está aberto
   fica preenchido e com o chevron virado, para se perceber de onde é que
   este painel saiu.

   `filtroFn` decide quem entra na lista e `listaBase` é de onde se filtra:
   os monocasta para o card do meio, todos os com stock para os outros. */
const RESUMO_NOME={mono:'Monocasta',regiao:'Regiões',casta:'Castas',valor:'Valor',falta:'A completar'};
function resumoPainel(id,titulo,rows,filtroFn,listaBase,notaTop){
  const fechar=`<button class="rdet-x" onclick="resumoFechar()" title="Fechar">✕</button>`;
  if(RESUMO_DRILL){
    const vs=listaBase.filter(filtroFn).slice().sort((a,b)=>a.nome.localeCompare(b.nome,'pt'));
    return `<div class="sc-det">
      <div class="rdet-bar">
        <button class="rdet-back" onclick="resumoVoltar()">‹ ${esc(RESUMO_NOME[id]||'Voltar')}</button>
        <div class="rdet-cab">${esc(RESUMO_DRILL)} <i>· ${vs.length} vinho${vs.length===1?'':'s'}</i></div>
        ${fechar}
      </div>
      <div class="rdet-lista">${vs.map(vinhoCardHTML).join('')||'<div class="note">Sem vinhos.</div>'}</div>
    </div>`;
  }
  return `<div class="sc-det">
    <div class="rdet-bar"><div class="rdet-cab">${esc(titulo)}</div>${fechar}</div>
    ${notaTop?`<div class="rdet-nota">${notaTop}</div>`:''}
    <div class="rdet-rows">${rows.length
      ?rows.map(r=>`<div class="rdet-row" onclick="resumoDrill('${id}','${escJs(r.nome)}')">
        <span>${esc(r.nome)}</span><span class="rdet-n">${esc(r.txt!=null?r.txt:String(r.n))}</span></div>`).join('')
      :'<div class="note" style="padding:8px 0">Sem dados ainda.</div>'}</div>
  </div>`;
}
/* O VALOR da garrafeira é uma ESTIMATIVA e diz-se isso: vale o que se
   pagou (`preco_compra`) quando se sabe, e o preço médio do vinho quando
   não se sabe. Garrafas sem nenhum dos dois não contam — inventar um preço
   para elas era pôr no cartão um número que ninguém podia conferir. */
function valorGarrafa(g){
  if(g.preco_compra!=null)return Number(g.preco_compra);
  const v=IDXV[g.vinho_id];
  return v&&v.preco_medio!=null?Number(v.preco_medio):null;
}
function valorVinho(v){
  return garrafasDe(v.id,true).reduce((s,g)=>{const x=valorGarrafa(g);return x==null?s:s+x;},0);
}

// O painel do valor organiza-se por INTERVALO DE PREÇO, não por local — é a
// pergunta que se faz a seguir a "quanto vale isto": "está sobretudo em
// garrafas baratas ou caras?". `faixaIndice` decide sempre a MESMA faixa
// para o mesmo valor, tanto a somar como a filtrar o drill-down.
const FAIXAS_PRECO=[
  {nome:'Até 15€',max:15},
  {nome:'Entre 15€ e 30€',max:30},
  {nome:'Entre 30€ e 50€',max:50},
  {nome:'Acima de 50€',max:Infinity}
];
function faixaIndice(valor){
  return FAIXAS_PRECO.findIndex(f=>valor<=f.max);
}

/* O que falta preencher num vinho. É a lista do que a app mostra e a
   procura usa — sem casta não há filtro por casta, sem preço não há valor,
   sem imagem o cartão fica com a garrafa desenhada em vez do rótulo. */
const FALTAS=[
  {k:'Sem imagem do rótulo',tem:v=>!!String(v.imagem_url||'').trim()},
  {k:'Sem castas',          tem:v=>(v.castas||[]).length>0},
  {k:'Sem preço médio',     tem:v=>v.preco_medio!=null},
  {k:'Sem classificação',   tem:v=>!!v.classificacao},
  {k:'Sem nota Vivino',     tem:v=>v.vivino_nota!=null}
];
function faltasDe(v){return FALTAS.filter(f=>!f.tem(v)).map(f=>f.k);}

function renderResumo(){
  const box=document.getElementById('resumo-cards');
  if(!box)return;
  const comStock=db.vinhos.filter(v=>stockDe(v.id)>0);
  const totalVinhos=comStock.length;

  const monoWines=comStock.filter(v=>(v.castas||[]).length===1);
  const monoRows=contarPor(monoWines,v=>[v.castas[0]]);

  const regRows=contarPor(comStock,v=>[v.regiao||'Sem região']);
  regRows.sort((a,b)=>(a.nome==='Sem região')-(b.nome==='Sem região')||b.n-a.n||a.nome.localeCompare(b.nome,'pt'));
  const nRegioes=new Set(comStock.map(v=>v.regiao).filter(Boolean)).size;

  // Aqui o mesmo vinho conta para CADA casta que tiver — a soma das linhas
  // pode passar o total de vinhos, e é suposto: não é o mesmo número do
  // primeiro card, é "em quantos vinhos aparece cada casta".
  const casRows=contarPor(comStock,v=>v.castas||[]);

  // Os quatro cards ficam sempre juntos na grelha 2×2 e o painel abre a
  // seguir, a toda a largura (`grid-column:1/-1`). Pô-lo logo a seguir ao
  // card aberto partia a grelha ao meio e deixava buracos.
  // VALOR: por intervalo de preço — "está sobretudo em garrafas baratas ou
  // caras?". As garrafas sem preço nenhum ficam de fora e dizem-se no
  // subtítulo, para o número não parecer mais certo do que é.
  const ativas=db.garrafas.filter(naGarrafeira);
  const comPreco=ativas.filter(g=>valorGarrafa(g)!=null);
  const valorTotal=comPreco.reduce((s,g)=>s+valorGarrafa(g),0);
  const valorMedio=comPreco.length?valorTotal/comPreco.length:0;
  const porFaixa=FAIXAS_PRECO.map(f=>({nome:f.nome,soma:0}));
  comPreco.forEach(g=>{porFaixa[faixaIndice(valorGarrafa(g))].soma+=valorGarrafa(g);});
  const valRows=porFaixa.filter(r=>r.soma>0).map(r=>({nome:r.nome,n:r.soma,txt:eur0(r.soma)}));

  // A COMPLETAR: os vinhos a quem falta alguma coisa que a app usa.
  const faltosos=comStock.filter(v=>faltasDe(v).length);
  const falRows=FALTAS.map(f=>({nome:f.k,n:comStock.filter(v=>!f.tem(v)).length}))
    .filter(r=>r.n>0).sort((a,b)=>b.n-a.n);

  // PREFERIDAS: a região e a casta com mais vinhos agora mesmo — não é
  // guardado em lado nenhum, é sempre o topo de regRows/casRows.
  const topRegiao=regRows.length&&regRows[0].nome!=='Sem região'?regRows[0]:null;
  const topCasta=casRows.length?casRows[0]:null;
  const topCastaMono=topCasta?(monoRows.find(m=>m.nome===topCasta.nome)||{n:0}).n:0;
  let favHtml='';
  if(topRegiao)favHtml+=scCardFav('Região preferida',topRegiao.nome,
    `${topRegiao.n} vinho${topRegiao.n===1?'':'s'}`,'regiao');
  if(topCasta)favHtml+=scCardFav('Casta preferida',topCasta.nome,
    `${topCasta.n} vinho${topCasta.n===1?'':'s'}${topCastaMono?`, ${topCastaMono} monocasta`:''}`,'casta');

  let html=
    scCard('','Vinhos',totalVinhos,totalVinhos===1?'vinho na garrafeira':'vinhos na garrafeira',null)+
    scCard('co','Monocasta',monoWines.length,totalVinhos?`de ${totalVinhos} vinhos`:'','mono')+
    scCard('cv','Regiões',nRegioes,'diferentes','regiao')+
    scCard('cb','Castas',casRows.length,'diferentes','casta')+
    favHtml+
    scCard('co','Valor estimado',`<span class="sc-eur">${esc(eur0(valorTotal))}</span>`,
      comPreco.length===ativas.length?`${ativas.length} garrafa${ativas.length===1?'':'s'}`
        :`${comPreco.length} de ${ativas.length} garrafas com preço`,'valor')+
    scCard('cb','A completar',faltosos.length,
      faltosos.length?'vinhos com dados em falta':'está tudo preenchido','falta');

  if(RESUMO_ABERTO==='mono')
    html+=resumoPainel('mono','Vinhos monocasta, por casta',monoRows,v=>(v.castas||[])[0]===RESUMO_DRILL,monoWines);
  if(RESUMO_ABERTO==='regiao')
    html+=resumoPainel('regiao','Vinhos por região',regRows,v=>(v.regiao||'Sem região')===RESUMO_DRILL,comStock);
  if(RESUMO_ABERTO==='casta')
    html+=resumoPainel('casta','Vinhos por casta',casRows,v=>(v.castas||[]).includes(RESUMO_DRILL),comStock);
  if(RESUMO_ABERTO==='valor')
    html+=resumoPainel('valor','Valor estimado, por intervalo de preço',valRows,
      v=>garrafasDe(v.id,true).some(g=>{const x=valorGarrafa(g);return x!=null&&FAIXAS_PRECO[faixaIndice(x)].nome===RESUMO_DRILL;}),
      comStock,
      comPreco.length?`Valor médio: <b>${esc(eur0(valorMedio))}</b> por garrafa, sobre ${comPreco.length} garrafa${comPreco.length===1?'':'s'} com preço conhecido.`:'');
  if(RESUMO_ABERTO==='falta')
    html+=resumoPainel('falta','O que falta preencher',falRows,
      v=>faltasDe(v).includes(RESUMO_DRILL),comStock);

  box.innerHTML=html;
}

/* ── PESQUISA (Detalhe + Locais) ────────────────────────────────────
   A mesma procura — texto, local, tipo, região, casta, produtor, monocasta,
   ano, menção, preço, grau alcoólico e maturação — filtra os dois
   separadores onde vive: a lista
   organizada do Detalhe e o mapa dos Locais. Já não está no ecrã inicial:
   com os dois separadores a ganhá-la, ter uma terceira cópia era ter três
   sítios com a mesma pergunta. */
function renderFiltrados(){
  renderFiltros();
  const fc=document.getElementById('f-count');
  const fl=document.getElementById('f-limpar');
  const info=document.getElementById('fbar-info');
  const tx=document.getElementById('f-texto');
  document.getElementById('f-texto-x').classList.toggle('on',!!tx.value);
  if(!haFiltros()){
    info.style.display='none';fl.style.display='none';fc.textContent='';
  }else{
    info.style.display='';fl.style.display='';
    const res=vinhosFiltrados();
    const nGar=res.reduce((s,v)=>s+stockDe(v.id),0);
    fc.textContent=`${res.length} vinho${res.length===1?'':'s'} · ${nGar} garrafa${nGar===1?'':'s'}`;
  }
  renderDetalhe();
  renderMapa();
}

/* ── FILTROS ───────────────────────────────────────────────────────
   Os valores possíveis de cada filtro saem SEMPRE dos dados que lá estão
   (não de listas fixas): assim uma região nova aparece no filtro sozinha,
   e nunca fica um filtro a apontar para coisa nenhuma. */
let F={local:'',tipo:'',regiao:'',casta:'',produtor:'',ano:'',mencao:'',castaN:'',preco:'',teor:'',janela:'',vivino:''};

// Intervalos da nota do Vivino, do mesmo jeito que FAIXAS_PRECO: a pergunta
// não é "qual é a nota exata" (isso o cartão já mostra), é "está bem
// cotado ou não" — por isso intervalo, não valor a valor. `faixaVivinoIndice`
// devolve sempre o mesmo intervalo para a mesma nota.
const FAIXAS_VIVINO=[
  {nome:'4,5 ★ ou mais',min:4.5},
  {nome:'4,0 a 4,5 ★',min:4},
  {nome:'3,5 a 4,0 ★',min:3.5},
  {nome:'Abaixo de 3,5 ★',min:0}
];
function faixaVivinoIndice(nota){
  return FAIXAS_VIVINO.findIndex(f=>nota>=f.min);
}

// Grau alcoólico (`teor`, % vol.) em faixas, do mesmo jeito que o preço —
// a pergunta é "é um vinho leve ou encorpado", não o valor exato.
const FAIXAS_TEOR=[
  {nome:'Até 12%',max:12},
  {nome:'12% a 13%',max:13},
  {nome:'13% a 14%',max:14},
  {nome:'Acima de 14%',max:Infinity}
];
function faixaTeorIndice(valor){
  return FAIXAS_TEOR.findIndex(f=>valor<=f.max);
}

function opcoesFiltro(){
  const comStock=db.vinhos.filter(v=>stockDe(v.id)>0);
  const set=(arr)=>[...new Set(arr.filter(x=>x!==''&&x!=null))];
  const castas=set([].concat(...comStock.map(v=>v.castas||[]))).sort((a,b)=>a.localeCompare(b,'pt'));
  const locais=db.locais.filter(l=>db.garrafas.some(g=>g.local_id===l.id&&naGarrafeira(g)));
  return {
    local:locais.map(l=>[String(l.id),l.nome]),
    tipo:set(comStock.map(v=>v.tipo)).sort().map(x=>[x,x]),
    regiao:set(comStock.map(v=>v.regiao)).sort((a,b)=>a.localeCompare(b,'pt')).map(x=>[x,x]),
    casta:castas.map(x=>[x,x]),
    produtor:set(comStock.map(v=>v.produtor)).sort((a,b)=>a.localeCompare(b,'pt')).map(x=>[x,x]),
    ano:set(comStock.map(v=>v.ano)).sort((a,b)=>b-a).map(x=>[String(x),String(x)]),
    mencao:set(comStock.map(v=>v.mencao)).sort((a,b)=>a.localeCompare(b,'pt')).map(x=>[x,x])
  };
}
/* Cada filtro é um chip DESENHADO por nós com o <select> nativo por cima,
   invisível (opacity:0, inset:0). O desenho passa a ser nosso — texto do
   valor escolhido, estado ligado/desligado, tudo pill — e quem abre a lista
   continua a ser o seletor do telemóvel, que é o que uma pessoa sabe usar.
   Um dropdown feito à mão em JS era mais código e pior no iOS.

   E deixam de estar todos à vista: escondem-se atrás do botão "Filtros",
   que traz o número dos que estão ligados. O que fica sempre visível são as
   "pastilhas" do que está a filtrar agora, cada uma com o seu ✕ — antes
   só havia "limpar filtros", tudo ou nada. */
const F_META={local:['📍','Local'],tipo:['🍷','Tipo'],regiao:['🗺️','Região'],casta:['🍇','Casta'],
  produtor:['🏭','Produtor'],castaN:['🧬','Nº de castas'],ano:['📅','Ano'],mencao:['🏅','Menção'],
  preco:['💶','Preço'],teor:['🌡️','Grau alcoólico'],janela:['⏱️','Maturação'],vivino:['★','Vivino']};
let FILTROS_ABERTOS=false;
function toggleFiltros(){
  FILTROS_ABERTOS=!FILTROS_ABERTOS;
  document.getElementById('filtros').classList.toggle('aberto',FILTROS_ABERTOS);
}
function limparTexto(){
  const c=document.getElementById('f-texto');
  c.value='';renderFiltrados();c.focus();
}
function listasFiltro(){
  const o=opcoesFiltro();
  o.castaN=[['1','Monocasta'],['2','Várias castas'],['0','Sem castas registadas']];
  o.janela=[['ponto','No ponto'],['cedo','Ainda cedo'],['passou','Já passou']];
  o.vivino=FAIXAS_VIVINO.map((f,i)=>[String(i),f.nome]);
  o.preco=FAIXAS_PRECO.map((f,i)=>[String(i),f.nome]);
  o.teor=FAIXAS_TEOR.map((f,i)=>[String(i),f.nome]);
  return o;
}
function rotuloFiltro(listas,k){
  const par=(listas[k]||[]).find(p=>p[0]===F[k]);
  return par?par[1]:F[k];
}
function renderFiltros(){
  const listas=listasFiltro();
  document.getElementById('f-selects').innerHTML=Object.keys(F_META).map(k=>{
    const [ico,nome]=F_META[k];
    const pares=listas[k]||[];
    const txt=F[k]?rotuloFiltro(listas,k):nome;
    return `<label class="fchip${F[k]?' ativo':''}">
      <span>${ico} ${esc(txt)}</span><span class="fchev">▾</span>
      <select onchange="setFiltro('${k}',this.value)">
        <option value="">${esc(nome)} — todos</option>
        ${pares.map(([v,t])=>`<option value="${esc(v)}"${F[k]===v?' selected':''}>${esc(t)}</option>`).join('')}
      </select>
    </label>`;
  }).join('');

  const ativos=Object.keys(F_META).filter(k=>F[k]);
  const n=document.getElementById('f-n');
  n.textContent=ativos.length;n.classList.toggle('on',!!ativos.length);
  document.getElementById('f-activos').innerHTML=ativos.map(k=>
    `<span class="fpill">${F_META[k][0]} ${esc(rotuloFiltro(listas,k))}
      <button onclick="setFiltro('${k}','')" title="Tirar este filtro">✕</button></span>`).join('');
}
function setFiltro(k,v){F[k]=v;renderFiltrados();}
function limparFiltros(){
  Object.keys(F).forEach(k=>F[k]='');
  document.getElementById('f-texto').value='';
  renderFiltrados();
}
function haFiltros(){
  return Object.values(F).some(Boolean)||!!document.getElementById('f-texto').value.trim();
}

// Um vinho passa no texto se o termo estiver em qualquer coisa que o
// identifique — nome, produtor, região, casta, ano, menção ou notas. Vários
// termos separados por espaço têm de estar TODOS presentes (é o que faz
// "touriga douro" devolver o que interessa em vez de tudo).
function passaTexto(v,termos){
  if(!termos.length)return true;
  const alvo=chave([v.nome,v.produtor,v.regiao,v.sub_regiao,v.tipo,v.estilo,v.mencao,
    v.ano,(v.castas||[]).join(' '),v.notas,v.notas_prova,v.harmonizacao].join(' '));
  return termos.every(t=>alvo.includes(t));
}
function vinhosFiltrados(){
  const termos=chave(document.getElementById('f-texto').value).split(/\s+/).filter(Boolean);
  return db.vinhos.filter(v=>{
    const gs=garrafasDe(v.id,true);
    if(!gs.length)return false;                                  // só o que está lá
    if(F.local&&!gs.some(g=>String(g.local_id)===F.local))return false;
    if(F.tipo&&v.tipo!==F.tipo)return false;
    if(F.regiao&&v.regiao!==F.regiao)return false;
    if(F.casta&&!(v.castas||[]).includes(F.casta))return false;
    if(F.produtor&&v.produtor!==F.produtor)return false;
    if(F.ano&&String(v.ano)!==F.ano)return false;
    if(F.mencao&&v.mencao!==F.mencao)return false;
    if(F.janela&&janelaBeber(v)!==F.janela)return false;
    if(F.vivino&&(v.vivino_nota==null||String(faixaVivinoIndice(v.vivino_nota))!==F.vivino))return false;
    if(F.preco&&(v.preco_medio==null||String(faixaIndice(v.preco_medio))!==F.preco))return false;
    if(F.teor&&(v.teor==null||String(faixaTeorIndice(v.teor))!==F.teor))return false;
    if(F.castaN){
      const n=(v.castas||[]).length;
      if(F.castaN==='1'&&n!==1)return false;
      if(F.castaN==='2'&&n<2)return false;
      if(F.castaN==='0'&&n!==0)return false;
    }
    return passaTexto(v,termos);
  });
}
// Dentro de cada grupo (região, ano ou casta), do melhor Vivino para o
// pior — é a pergunta natural depois de já se ter escolhido o grupo: "qual
// destes bebo primeiro?". Sem nota fica no fim, por nome.
function ordenarPorVivino(lista){
  return lista.slice().sort((a,b)=>
    (b.vivino_nota??-1)-(a.vivino_nota??-1)||a.nome.localeCompare(b.nome,'pt'));
}
// Agrupa a lista já filtrada para o separador Detalhe. Por região e por
// casta: grupos alfabéticos; por ano: do mais recente para o mais velho.
function agruparVinhos(lista,modo){
  if(modo==='ano'){
    const porAno={};
    lista.forEach(v=>{const k=v.ano||'__semano';(porAno[k]=porAno[k]||[]).push(v);});
    const anos=Object.keys(porAno).filter(k=>k!=='__semano').map(Number).sort((a,b)=>b-a);
    const grupos=anos.map(a=>({titulo:String(a),vinhos:ordenarPorVivino(porAno[a])}));
    if(porAno['__semano'])grupos.push({titulo:'Sem ano',vinhos:ordenarPorVivino(porAno['__semano'])});
    return grupos;
  }
  if(modo==='casta'){
    // Monocasta primeiro, casta a casta ("100% Syrah"), e só depois
    // "Várias Castas" — é a pergunta "o que é isto, puro?" antes da mistura.
    const mono={},varias=[],semCasta=[];
    lista.forEach(v=>{
      const n=(v.castas||[]).length;
      if(n===1)(mono[v.castas[0]]=mono[v.castas[0]]||[]).push(v);
      else if(n>1)varias.push(v);
      else semCasta.push(v);
    });
    const nomes=Object.keys(mono).sort((a,b)=>a.localeCompare(b,'pt'));
    const grupos=nomes.map(n=>({titulo:`100% ${n}`,vinhos:ordenarPorVivino(mono[n])}));
    if(varias.length)grupos.push({titulo:'Várias Castas',vinhos:ordenarPorVivino(varias)});
    if(semCasta.length)grupos.push({titulo:'Sem castas registadas',vinhos:ordenarPorVivino(semCasta)});
    return grupos;
  }
  const porReg={};
  lista.forEach(v=>{const k=v.regiao||'__semregiao';(porReg[k]=porReg[k]||[]).push(v);});
  const regs=Object.keys(porReg).filter(k=>k!=='__semregiao').sort((a,b)=>a.localeCompare(b,'pt'));
  const grupos=regs.map(r=>({titulo:r,vinhos:ordenarPorVivino(porReg[r])}));
  if(porReg['__semregiao'])grupos.push({titulo:'Sem região',vinhos:ordenarPorVivino(porReg['__semregiao'])});
  return grupos;
}
let DET_AGRUPAR='regiao';
function detAgrupar(modo){
  DET_AGRUPAR=modo;
  document.getElementById('seg-regiao').classList.toggle('on',modo==='regiao');
  document.getElementById('seg-ano').classList.toggle('on',modo==='ano');
  document.getElementById('seg-casta').classList.toggle('on',modo==='casta');
  renderDetalhe();
}

/* ── LISTA ───────────────────────────────────────────────────────────
   O cartão tem TRÊS zonas, sempre pela mesma ordem, e é a posição (não a
   cor) que diz o que cada coisa é:
     1. a garrafa — a imagem do vinho, com a quantidade ao canto;
     2. a identidade — nome, ano (com a nota do Vivino por baixo, em
        `.vc-anofloat`), produtor/tipo/região, castas, menção e preço médio.
        A classificação (DOC/Vinho Regional) já não vem aqui — cabe pouco e
        já está na ficha do vinho; não precisa de estar nos dois sítios;
     3. o rodapé, depois de um filete — o que é FÍSICO: onde está e se está
        no ponto de beber.
   `.vc-anofloat` é um FLOAT (`float:right`), não uma coluna flex ao lado do
   nome: com flex, a altura da linha do nome ficava presa à do lado do
   ano+nota, e um nome de uma linha só sobrava com um espaço em branco por
   baixo antes do resto da ficha começar. Com float, o nome (e o resto, se
   for preciso) contorna a caixa do ano+nota em vez de esperar por ela —
   sobe para o lado dela em vez de ficar parado por baixo. `.vc-main` passa
   a `display:flow-root` (não `flex`) precisamente para os filhos poderem
   flutuar: um item de flex ignora `float` (é a própria spec do CSS).
   Antes vinha tudo no mesmo monte de crachás, cada um com a sua cor: sete
   cores ao lado umas das outras não são hierarquia nenhuma, e o olho não
   sabia onde pousar. Agora só o dourado (menção/nota) e o pip do local têm
   cor própria. */
function vinhoCardHTML(v){
  const gs=garrafasDe(v.id,true);
  const cl=castaLabel(v);
  const jan=janelaBeber(v);
  const castas=v.castas||[];
  const castasTxt=castas.length
    ? castas.slice(0,2).join(' · ')+(castas.length>2?' +'+(castas.length-2):'')
    : '';
  // Duas garrafas do mesmo vinho no MESMO sítio não valem duas linhas. Cada
  // sítio leva o pip com a cor do local — é o que restou da barra de cor.
  const sitios=[];
  gs.forEach(g=>{
    const txt=nomeLocal(g.local_id)+(g.prateleira?' · '+g.prateleira:'');
    if(!sitios.some(x=>x.txt===txt))sitios.push({txt,cor:(IDXL[g.local_id]||{}).cor||'#7b1f3d'});
  });
  return `<article class="vcard" onclick="verVinho(${v.id})">
    <div class="vc-top">
      ${vinhoThumb(v,gs.length)}
      <div class="vc-main">
        <div class="vc-anofloat">
          <div class="vc-ano">${v.ano||'s/a'}</div>
          ${v.vivino_nota?`<span class="bdg viv">★ ${Number(v.vivino_nota).toFixed(1)}</span>`:''}
        </div>
        <div class="vc-nome">${esc(v.nome)}</div>
        <div class="vc-sub">${esc([v.produtor,[v.tipo,v.estilo].filter(Boolean).join(' '),v.regiao].filter(Boolean).join(' · '))}</div>
        <div class="vc-badges">
          ${castasTxt?`<span class="bdg cas">🍇 ${esc(castasTxt)}</span>`:''}
          ${cl?`<span class="bdg mono">${esc(cl)}</span>`:''}
          ${v.mencao?`<span class="bdg men">${esc(v.mencao)}</span>`:''}
          ${v.preco_medio!=null?`<span class="bdg">${esc(eur0(v.preco_medio))}</span>`:''}
        </div>
        <div class="vc-foot">
          ${sitios.map(x=>`<span class="vc-l"><span class="vc-pip" style="background:${esc(x.cor)}"></span><b>${esc(x.txt)}</b></span>`).join('')}
          ${jan?`<span class="bdg jan ${jan}">${JANELA_TXT[jan]}</span>`:''}
        </div>
      </div>
    </div>
  </article>`;
}
// A lista completa, organizada por região, ano ou casta — e, quando a
// procura tem alguma coisa ligada, só os vinhos que passam nela (a mesma
// organização, com menos vinhos dentro).
function renderDetalhe(){
  const box=document.getElementById('detalhe-grupos');
  if(!box)return;
  const filtrando=haFiltros();
  const res=filtrando?vinhosFiltrados():db.vinhos.filter(v=>stockDe(v.id)>0);
  const nGar=res.reduce((s,v)=>s+stockDe(v.id),0);
  document.getElementById('det-count').textContent=
    `${res.length} vinho${res.length===1?'':'s'} · ${nGar} garrafa${nGar===1?'':'s'}`;
  if(!res.length){
    box.innerHTML=filtrando
      ?'<div class="vazio"><b>Nada encontrado</b>Nenhum vinho corresponde a esta procura.</div>'
      :'<div class="vazio"><b>Ainda sem vinhos</b>Toca no + para pôr o primeiro.</div>';
    return;
  }
  const grupos=agruparVinhos(res,DET_AGRUPAR);
  box.innerHTML=grupos.map(g=>`<div class="dgrupo">
      <div class="dgrupo-tit">${esc(g.titulo)} <span class="dgrupo-n">${g.vinhos.length}</span></div>
      ${g.vinhos.map(vinhoCardHTML).join('')}
    </div>`).join('');
}

// Dispatcher chamado depois de QUALQUER mutação (guardar, apagar, consumir,
// mover…): atualiza os três sítios que mostram vinhos, sem se preocupar com
// qual separador está aberto — o dataset é pequeno, refazer os três é mais
// simples e mais seguro do que tentar adivinhar o que precisa de mudar.
function renderLista(){
  renderResumo();
  renderFiltrados();
}

/* ── MAPA DOS LOCAIS ───────────────────────────────────────────────
   O desenho da garrafeira: local -> prateleira -> lugares. Só garrafas que
   lá estão — o histórico dos consumos vive no separador próprio.

   Os contadores: continuam lá, mas em serifa e COM A PALAVRA à frente —
   "9 vinhos", "12 garrafas". Um número solto num canto não diz de quê, e
   aqui as duas contagens são mesmo coisas diferentes: 12 garrafas podem
   ser 9 vinhos (há repetidos). Cada lugar é uma célula com a garrafinha
   desenhada, o nome do vinho e o lugar em destaque. */
function renderMapa(){
  const box=document.getElementById('mapa');
  if(!box)return;
  const filtrando=haFiltros();
  let ativas=db.garrafas.filter(naGarrafeira);
  if(filtrando){
    const okV=new Set(vinhosFiltrados().map(v=>v.id));
    ativas=ativas.filter(g=>okV.has(g.vinho_id)&&(!F.local||String(g.local_id)===F.local));
  }
  if(!ativas.length){
    box.innerHTML=filtrando
      ?'<div class="vazio"><b>Nada encontrado</b>Nenhuma garrafa corresponde a esta procura.</div>'
      :'<div class="vazio"><b>Garrafeira vazia</b>Ainda não há garrafas arrumadas.</div>';
    return;
  }

  // Garrafas sem local (o local foi apagado, ou nunca foi escolhido) não
  // podem sumir do mapa — é aí que se vê que estão por arrumar.
  const grupos=db.locais.map(l=>[l,ativas.filter(g=>g.local_id===l.id)]).filter(([,g])=>g.length);
  const orfas=ativas.filter(g=>!IDXL[g.local_id]);
  if(orfas.length)grupos.push([{id:null,nome:'Por arrumar',descricao:'Garrafas sem local escolhido',cor:'#8a8a8a'},orfas]);

  box.innerHTML=grupos.map(([l,gs])=>{
    const prats=[...new Set(gs.map(g=>g.prateleira||''))].sort(ordPrateleira);
    const nv=new Set(gs.map(g=>g.vinho_id)).size;
    return `<section class="mloc">
      <div class="mloc-head" style="--lc:${esc(l.cor||'#7b1f3d')}">
        <div class="mloc-id">
          <h3><span class="pip" style="background:${esc(l.cor||'#7b1f3d')}"></span>${esc(l.nome)}</h3>
          ${l.descricao?`<div class="mloc-sub">${esc(l.descricao)}</div>`:''}
        </div>
        <div class="mloc-n">
          <b>${nv}</b><span class="u">${nv===1?'vinho':'vinhos'}</span>
          <span>${gs.length} ${gs.length===1?'garrafa':'garrafas'}</span>
        </div>
      </div>
      ${prats.map(p=>{
        const cel=gs.filter(g=>(g.prateleira||'')===p)
          .sort((a,b)=>String(a.lugar).localeCompare(String(b.lugar),'pt',{numeric:true}));
        return `<div class="mprat">
          <div class="mprat-t">${esc(p||'Sem prateleira')}
            <span class="mprat-n">${cel.length} ${cel.length===1?'garrafa':'garrafas'}</span></div>
          <div class="mgrid">${cel.map(g=>{
            const v=IDXV[g.vinho_id]||{nome:'?'};
            return `<button class="mcell" onclick="verVinho(${g.vinho_id})" title="${esc(v.nome)} ${v.ano||''}">
              ${garrafaSVG(v,1)}
              <span class="mcell-tx"><b>${esc(v.nome)}</b><span>${v.ano||'s/ ano'}</span></span>
              ${g.lugar?`<span class="mlug">${esc(g.lugar)}</span>`:''}
            </button>`;
          }).join('')}</div>
        </div>`;
      }).join('')}
    </section>`;
  }).join('');
}

/* ── CONSUMIDOS ────────────────────────────────────────────────────
   O "onde é que bebi aquela relíquia". Consumir não apaga a garrafa: muda
   o estado e carimba data/sítio/nota, e é esta lista que os mostra. */
function renderConsumidos(){
  const gs=db.garrafas.filter(g=>g.estado==='consumida')
    .sort((a,b)=>String(b.consumido_em||'').localeCompare(String(a.consumido_em||'')));
  const ano=new Date().getFullYear();
  const nEsteAno=gs.filter(g=>String(g.consumido_em||'').startsWith(String(ano))).length;
  const notas=gs.filter(g=>g.consumo_avaliacao);
  const media=notas.length?(notas.reduce((s,g)=>s+g.consumo_avaliacao,0)/notas.length):0;
  document.getElementById('stats-consumo').innerHTML=`
    <div class="sc co"><div class="sc-l">Já bebidas</div><div class="sc-v">${gs.length}</div>
      <div class="sc-s">${nEsteAno} em ${ano}</div></div>
    <div class="sc"><div class="sc-l">Média das notas</div><div class="sc-v">${media?media.toFixed(1):'—'}</div>
      <div class="sc-s">${notas.length} avaliada${notas.length===1?'':'s'}</div></div>`;

  const box=document.getElementById('consumidos');
  if(!gs.length){box.innerHTML='<div class="vazio"><b>Nada bebido ainda</b>Ou ainda não se registou. Cada garrafa que se abre fica aqui com a data, o sítio e o que se achou.</div>';return;}
  box.innerHTML=gs.map(g=>{
    const v=IDXV[g.vinho_id]||{nome:'(vinho apagado)'};
    return `<div class="ccard">
      <div class="cc-top">
        <div class="cc-nome" onclick="verVinho(${g.vinho_id})" style="cursor:pointer">${esc(v.nome)} ${v.ano||''}</div>
        <div class="cc-data">${dataPT(g.consumido_em)}</div>
      </div>
      ${g.consumo_local?`<div class="cc-onde">📍 ${esc(g.consumo_local)}</div>`:''}
      ${g.consumo_avaliacao?`<div class="estrelas">${estrelas(g.consumo_avaliacao)}</div>`:''}
      ${g.consumo_nota?`<div class="cc-nota">"${esc(g.consumo_nota)}"</div>`:''}
      <div class="macoes ro-hide" style="margin-top:10px">
        <button class="mini" onclick="reporGarrafa(${g.id})">↩︎ Repor na garrafeira</button>
      </div>
    </div>`;
  }).join('');
}

/* ── PÁGINA DO VINHO ───────────────────────────────────────────────
   O detalhe. É daqui que saem as ações todas sobre um vinho: procurar
   informação na net/IA, consumir uma garrafa, editar, acrescentar garrafas.
   Por baixo continua a ser o `#modal-vinho` — o que mudou foi a pele
   (`.pagina`) e a saída (voltar do browser, Escape, ‹/✕, arrastar). */
// O que a procura da IA trouxe e o formulário de vinho novo não tem onde
// mostrar (resumo, notas de prova, link do Vivino). Vive só entre a procura
// e o gravar do MESMO formulário.
let _iaExtraNovo=null;
let VINHO_ABERTO=null;
function verVinho(id){
  const v=IDXV[id];
  if(!v){toast('Vinho não encontrado',1);return;}
  VINHO_ABERTO=id;
  document.getElementById('modal-vinho-in').innerHTML=vinhoDetalheHTML(v);
  abrirModal('modal-vinho');
  const p=pgVinho();
  p.scrollTop=0;              // é uma página nova, começa em cima
  pgCabecalho();              // e com o cabeçalho por inteiro
  pgEntrarHistoria();
}
function refrescarVinhoAberto(){
  if(VINHO_ABERTO!=null&&document.getElementById('modal-vinho').classList.contains('on')){
    const v=IDXV[VINHO_ABERTO];
    // Refazer o HTML deita fora o cabeçalho (e com ele o `.compacta`),
    // mas o scroll fica onde estava — daí o acerto a seguir.
    if(v){document.getElementById('modal-vinho-in').innerHTML=vinhoDetalheHTML(v);pgCabecalho();}
  }
}

/* ── A PÁGINA DO VINHO (comportamento) ─────────────────────────────
   A pele está no style.css ("PÁGINA DO VINHO"); aqui está o que se
   mexe: o cabeçalho a encolher ao rolar, o botão de voltar do
   telemóvel e o arrastar de lado para sair. */
function pgVinho(){return document.getElementById('modal-vinho');}

// O cabeçalho encolhe assim que se sai do topo. 54px é pouco mais do que
// um toque de scroll: mais do que isso e a barra só encolhia a meio da
// ficha, que é quando já não interessa.
function pgCabecalho(){
  const p=pgVinho(),h=p.querySelector('.mhero');
  if(h)h.classList.toggle('compacta',p.scrollTop>54);
}

/* Um passo na história por página aberta: no telemóvel (e no gesto de
   voltar do iOS) "atrás" fecha a ficha em vez de sair da app. Quem sai
   pelo ‹/✕/Escape gasta o passo em `fecharModal`; quem sai pelo voltar
   do browser cai no `popstate` — os dois caminhos põem `PG_HIST` a
   falso ANTES de mexer na história, que é o que impede o pingue-pongue
   entre um e outro. */
let PG_HIST=false;
function pgEntrarHistoria(){
  if(PG_HIST)return;
  try{history.pushState({gfVinho:1},'');PG_HIST=true;}catch(e){}
}
function pgSairHistoria(){
  if(!PG_HIST)return;
  PG_HIST=false;
  try{history.back();}catch(e){}
}
window.addEventListener('popstate',()=>{
  if(!PG_HIST)return;
  PG_HIST=false;
  // Voltar fecha a página e o que estiver aberto POR CIMA dela (editar,
  // consumir, foto): são todos o mesmo contexto — este vinho.
  document.querySelectorAll('.modal.on').forEach(m=>m.classList.remove('on'));
});

/* Arrastar de lado para sair. Segue o dedo nos DOIS sentidos: pediu-se
   para a esquerda, mas quem vem do iOS/Android arrasta para a direita —
   travar um dos lados era ensinar uma regra nova sem necessidade.
   Só pega se o gesto for claramente horizontal (senão roubava o scroll)
   e nunca começa dentro de um campo ou de um link. */
let _pgSw=null;
function pgSwipe(){
  const p=pgVinho();
  const box=()=>p.querySelector('.mbox');
  p.addEventListener('touchstart',e=>{
    _pgSw=null;
    if(e.touches.length!==1||!p.classList.contains('on'))return;
    if(document.querySelectorAll('.modal.on').length>1)return;   // há coisa por cima
    if(e.target.closest('input,textarea,select,a,button'))return;
    p.classList.remove('a-soltar');
    _pgSw={x:e.touches[0].clientX,y:e.touches[0].clientY,dx:0,pegou:false};
  },{passive:true});
  p.addEventListener('touchmove',e=>{
    if(!_pgSw||e.touches.length!==1)return;
    const dx=e.touches[0].clientX-_pgSw.x, dy=e.touches[0].clientY-_pgSw.y;
    if(!_pgSw.pegou){
      if(Math.abs(dy)>Math.abs(dx)){_pgSw=null;return;}           // é scroll, deixa passar
      if(Math.abs(dx)<14)return;                                   // ainda não se sabe
      _pgSw.pegou=true;p.classList.add('a-arrastar');
    }
    _pgSw.dx=dx;
    const b=box();
    if(b){
      b.style.transform='translateX('+dx.toFixed(1)+'px)';
      b.style.opacity=String(Math.max(.35,1-Math.abs(dx)/(window.innerWidth*.9)));
    }
    if(e.cancelable)e.preventDefault();
  },{passive:false});
  const largar=()=>{
    if(!_pgSw)return;
    const dx=_pgSw.dx,pegou=_pgSw.pegou,b=box();_pgSw=null;
    p.classList.remove('a-arrastar');
    if(b){b.style.transform='';b.style.opacity='';}
    if(!pegou)return;
    // Um quarto do ecrã (ou 110px) é o ponto de não voltar atrás.
    if(Math.abs(dx)>Math.min(110,window.innerWidth*.28)){fecharModal('modal-vinho');return;}
    p.classList.add('a-soltar');
    setTimeout(()=>p.classList.remove('a-soltar'),220);
  };
  p.addEventListener('touchend',largar);
  p.addEventListener('touchcancel',largar);
  p.addEventListener('scroll',pgCabecalho,{passive:true});
}
function linha(rot,val){
  return val?`<div class="mdl"><b>${esc(rot)}</b><span>${val}</span></div>`:'';
}
/* A capa do vinho: a garrafa (ou a foto do rótulo), o nome e a origem
   sobre o bordô, com a nota do Vivino e a maturação já lá em cima. O
   resto — ficha, onde está, o que se bebeu — fica em papel por baixo,
   com as secções separadas por filete.
   Esta capa é também a BARRA da página: fica colada ao topo e encolhe ao
   rolar (ver "PÁGINA DO VINHO"), por isso tem dois botões — ‹ à esquerda
   e ✕ à direita, o mesmo par do painel do resumo. */
function vinhoDetalheHTML(v){
  const ativas=garrafasDe(v.id,true), bebidas=garrafasDe(v.id,false).filter(g=>g.estado==='consumida');
  const cl=castaLabel(v), jan=janelaBeber(v);
  const estagio=v.estagio_texto||(v.estagio_meses?`${v.estagio_meses} meses`:'');
  const idadeInfo=v.beber_de||v.beber_ate
    ? `${v.beber_de||'?'} – ${v.beber_ate||'?'}${jan?`  <span class="bdg jan ${jan}">${JANELA_TXT[jan]}</span>`:''}` : '';
  const img=imagemDe(v);
  const origem=[v.produtor,v.regiao,v.sub_regiao].filter(Boolean).map(esc).join(' · ');

  // Links pequenos, seguidos por vírgula: o Vivino primeiro (se houver),
  // depois os do utilizador, cada um com o seu ✕ para remover colado a
  // seguir ao nome — não em caixas separadas, que ocupavam uma linha cada.
  const linkItens=[];
  if(v.vivino_url)linkItens.push(`<a href="${esc(v.vivino_url)}" target="_blank" rel="noopener">Ver no Vivino</a>`);
  if(TEM_LINKS)(v.links||[]).forEach((l,i)=>{
    linkItens.push(`<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.titulo||l.url)}</a><button class="mlink-x ro-hide" onclick="removerLink(${v.id},${i})" title="Remover">✕</button>`);
  });

  return `<div class="mhero">
      <button class="mx mvolta" onclick="fecharModal('modal-vinho')" title="Voltar">‹</button>
      <button class="mx" onclick="fecharModal('modal-vinho')">✕</button>
      <div class="mhero-in">
        <button class="mhero-g" onclick="abrirFoto(${v.id})" title="Ver a imagem em grande">
          ${garrafaSVG(v)}${img?`<img src="${esc(img)}" alt="" onerror="this.remove()">`:''}
          <span class="mhero-lupa">⤢</span>
        </button>
        <div class="mhero-tx">
          <div class="mhero-k">${esc([v.tipo,v.estilo,v.classificacao].filter(Boolean).join(' · '))||'&nbsp;'}</div>
          <h3>${esc(v.nome)}</h3>
          <div class="mhero-s"><span class="mhero-o">${origem}${origem&&v.ano?' · ':''}</span>${v.ano?`<b>${v.ano}</b>`:''}</div>
          ${v.vivino_nota?`<span class="mhero-n">★ ${Number(v.vivino_nota).toFixed(2)} Vivino${v.vivino_avaliacoes?` · ${v.vivino_avaliacoes}`:''}</span>`:''}
          ${jan?`<span class="mhero-n">${JANELA_TXT[jan]}</span>`:''}
        </div>
      </div>
    </div>

    <div class="vc-badges" style="margin-top:14px">
      ${v.mencao?`<span class="bdg men">${esc(v.mencao)}</span>`:''}
      ${cl?`<span class="bdg mono">${esc(cl)}</span>`:''}
      ${(v.castas||[]).map(c=>`<span class="bdg cas" onclick="filtrarPorCasta('${escJs(c)}')" style="cursor:pointer" title="Ver tudo com esta casta">🍇 ${esc(c)}</span>`).join('')}
    </div>

    <div class="macoes ro-hide">
      <button class="btn prim" onclick="iaEscolher(${v.id})">🔎 Procurar informação</button>
      <button class="btn ghost" onclick="abrirEditarVinho(${v.id})">✏️ Editar</button>
    </div>

    <div class="msec">Onde está</div>
    ${ativas.length
      ? ativas.map(g=>{
          const pos=[g.prateleira,g.lugar?'lugar '+g.lugar:''].filter(Boolean).join(' · ');
          const meta=[g.formato||'',g.preco_compra!=null?'comprada por '+eur(g.preco_compra):'',
                      g.comprado_em?dataPT(g.comprado_em):''].filter(Boolean).join(' · ');
          return `<div class="mgar">
          <div class="g-onde">
            <b>📍 ${esc(nomeLocal(g.local_id))}</b>
            ${pos?`<span class="g-pos">${esc(pos)}</span>`:''}
            ${meta?`<i>${esc(meta)}</i>`:''}
          </div>
          <button class="mini ro-hide" onclick="abrirGarrafa(${g.id})">Mover</button>
          <button class="mini o ro-hide" onclick="abrirConsumir(${v.id},${g.id})">Consumir</button>
        </div>`;}).join('')
      : `<div class="note" style="padding:8px 0">Não há garrafas deste vinho na garrafeira${bebidas.length?' — já foram todas bebidas':''}.</div>`}
    <button class="btn ghost ro-hide" onclick="abrirGarrafa(0,${v.id})">+ Acrescentar garrafa</button>

    <div class="msec">Ficha</div>
    <div class="mdet">
      ${linha('Produtor',esc(v.produtor))}
      ${linha('Ano',v.ano||'')}
      ${linha('Tipo',esc([v.tipo,v.estilo].filter(Boolean).join(' · ')))}
      ${linha('Região',esc([v.regiao,v.sub_regiao].filter(Boolean).join(' · ')))}
      ${linha('Classificação',esc(v.classificacao))}
      ${linha('Castas',(v.castas||[]).length?esc(v.castas.join(', ')):'')}
      ${linha('Estágio',esc(estagio))}
      ${linha('Álcool',v.teor?esc(v.teor)+'%':'')}
      ${linha('Preço médio',v.preco_medio!=null?eur(v.preco_medio):'')}
      ${linha('Beber entre',idadeInfo)}
      ${linha('Notas de prova',esc(v.notas_prova))}
      ${linha('Harmoniza com',esc(v.harmonizacao))}
      ${linha('As minhas notas',esc(v.notas))}
    </div>

    ${v.ai_resumo?`<div class="msec">O que se sabe</div>
      <div class="note" style="margin-top:8px;font-size:12.5px">${esc(v.ai_resumo)}</div>`:''}
    ${Array.isArray(v.ai_fontes)&&v.ai_fontes.length?`<div class="ia-fontes">
      Fontes: ${v.ai_fontes.map(f=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}
    </div>`:''}

    ${(TEM_LINKS||v.vivino_url)?`<div class="msec">Links</div>
      ${linkItens.length
        ? `<div class="mlinks">${linkItens.join(', ')}</div>`
        : '<div class="note" style="padding:8px 0">Sem links guardados.</div>'}
      ${TEM_LINKS?`<button class="btn ghost ro-hide" onclick="adicionarLink(${v.id})">+ Acrescentar link</button>`:''}`:''}

    ${bebidas.length?`<div class="msec">Já bebidas (${bebidas.length})</div>
      ${bebidas.sort((a,b)=>String(b.consumido_em).localeCompare(String(a.consumido_em))).map(g=>`
        <div class="mgar"><div class="g-onde"><b>${dataPT(g.consumido_em)}${g.consumo_local?' · '+esc(g.consumo_local):''}</b>
          <i>${g.consumo_avaliacao?estrelas(g.consumo_avaliacao)+' ':''}${esc(g.consumo_nota||'')}</i></div></div>`).join('')}`:''}

    <div class="msec">Atualizações</div>
    <div class="ia-fontes">
      Pesquisa com IA: ${v.ai_atualizado_em&&/^gemini/i.test(String(v.ai_modelo||''))
        ?dataHoraLocal(v.ai_atualizado_em):'ainda não'}<br>
      Atualização manual: ${dataHoraLocal(TEM_ATUALIZADO?(v.atualizado_em||v.criado_em):v.criado_em)}
    </div>

    <div class="macoes">
      <button class="btn ghost" onclick="fecharModal('modal-vinho')">Fechar</button>
      <button class="btn danger ro-hide" onclick="apagarVinho(${v.id})">🗑 Apagar vinho</button>
    </div>`;
}
// Diferente de `ai_fontes` (o que a IA encontrou, substituído por inteiro a
// cada procura): isto é do utilizador — a corrigir um link errado que a IA
// trouxe (ex.: Vivino a apontar para outro vinho) ou a acrescentar um que
// lhe faça sentido. `prompt()` para não pedir um modal só para dois campos —
// mesmo padrão de `abrirNovoLocal()`.
async function adicionarLink(id){
  if(roGuard())return;
  const v=IDXV[id];if(!v)return;
  const url=prompt('Link (endereço completo, com https://)');
  if(!url)return;
  if(!/^https?:\/\//i.test(url.trim())){toast('Isso não parece um link',1);return;}
  const titulo=prompt('Título (ex.: "Loja onde comprei")','')||'';
  const links=(v.links||[]).concat([{titulo:titulo.trim(),url:url.trim()}]);
  try{
    await sbReq('PATCH',`vinhos?id=eq.${id}`,{links});
    v.links=links;refrescarVinhoAberto();
  }catch(e){toast('Não foi possível guardar: '+e.message,1);}
}
async function removerLink(id,i){
  if(roGuard())return;
  const v=IDXV[id];if(!v||!Array.isArray(v.links))return;
  const links=v.links.slice();links.splice(i,1);
  const antes=v.links;
  v.links=links;refrescarVinhoAberto();
  try{await sbReq('PATCH',`vinhos?id=eq.${id}`,{links});}
  catch(e){v.links=antes;refrescarVinhoAberto();toast('Não foi possível apagar: '+e.message,1);}
}
/* ── A IMAGEM DO VINHO: ver em grande e trocar pela minha ───────────
   Toca-se na imagem da capa e ela abre aqui em grande, com o botão de
   substituir. A fotografia sai do telemóvel (câmara ou galeria — é o
   `accept="image/*"` que dá as duas opções no iOS) e é ENCOLHIDA no browser
   antes de subir: uma foto de telemóvel são 4 MB e o que interessa de um
   rótulo cabe em ~120 KB. Subir os 4 MB era encher o bucket e fazer a app
   arrastar-se em cada carregamento, para nada.

   A minha imagem NÃO apaga a que a IA encontrou: fica por cima
   (`imagem_path` ganha ao `imagem_url`). Tirar a minha faz reaparecer a
   outra — por isso é que são duas colunas e não uma. */
let FOTO_VINHO=null;
function abrirFoto(vinhoId){
  const v=IDXV[vinhoId];if(!v)return;
  FOTO_VINHO=vinhoId;
  const img=imagemDe(v), minha=imagemPropria(v);
  const fonte=minha?'A tua fotografia'
    :(img?'Encontrada na net pela procura':'Garrafa desenhada pela app');
  document.getElementById('modal-foto-in').innerHTML=`
    <div class="mtop"><div><h3>${esc(v.nome)}</h3>
      <div class="note" style="margin-top:3px">${esc(fonte)}</div></div>
      <button class="mx" onclick="fecharModal('modal-foto')">✕</button></div>

    <div class="foto-palco">
      <div class="foto-svg">${garrafaSVG(v)}</div>
      ${img?`<img src="${esc(img)}" alt="" onerror="this.remove()">`:''}
    </div>

    <div class="note" id="foto-estado"></div>

    <div class="macoes ro-hide">
      <label class="btn prim" style="text-align:center;cursor:pointer;margin:0">
        📷 ${minha?'Trocar a imagem':'Carregar uma imagem'}
        <input type="file" accept="image/*" style="display:none" onchange="enviarFoto(this)">
      </label>
      ${minha?`<button class="btn danger" onclick="apagarFotoPropria()">Remover a minha</button>`:''}
    </div>
    <div class="note" style="margin-top:10px">${minha
      ? 'Se removeres a tua, volta a aparecer a imagem que a procura encontrou (ou a garrafa desenhada).'
      : 'A tua imagem fica guardada na garrafeira e passa a ser a que aparece em todo o lado.'}</div>`;
  abrirModal('modal-foto');
}

/* Encolher no browser. `createImageBitmap` com `imageOrientation:'from-image'`
   trata do EXIF — sem isso as fotos tiradas na vertical apareciam deitadas,
   que é o clássico de quem carrega fotos de telemóvel. */
async function encolherImagem(file,max=1000,q=0.85){
  let bmp;
  try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'});}
  catch(e){bmp=await createImageBitmap(file);}
  const escala=Math.min(1,max/Math.max(bmp.width,bmp.height));
  const w=Math.round(bmp.width*escala), h=Math.round(bmp.height*escala);
  const c=document.createElement('canvas');c.width=w;c.height=h;
  c.getContext('2d').drawImage(bmp,0,0,w,h);
  bmp.close&&bmp.close();
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',q));
  if(!blob)throw new Error('não consegui ler essa imagem');
  return blob;
}

async function enviarFoto(input){
  if(roGuard())return;
  const file=(input.files||[])[0];
  if(!file)return;
  input.value='';                          // deixa escolher a MESMA foto outra vez
  const v=IDXV[FOTO_VINHO];if(!v)return;
  if(!TEM_IMAGEM_PATH){toast('A base de dados ainda não tem a coluna imagem_path',1);return;}
  const est=document.getElementById('foto-estado');
  est.textContent='A preparar a imagem…';
  try{
    const blob=await encolherImagem(file);
    // Nome novo em cada envio: um caminho fixo ficava preso à cache do
    // browser e da CDN, e a imagem trocada só aparecia horas depois.
    const caminho=`v${v.id}/${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}.jpg`;
    est.textContent=`A enviar (${Math.round(blob.size/1024)} KB)…`;
    const r=await sbFetch(`${SB_URL}/storage/v1/object/${BUCKET}/${caminho}`,{
      method:'POST',
      headers:{'apikey':SB_KEY,'Content-Type':'image/jpeg','x-upsert':'true'},
      body:blob
    });
    if(!r.ok){
      let m='HTTP '+r.status;try{m=(await r.json()).message||m;}catch(_){}
      throw new Error(m);
    }
    const antigo=String(v.imagem_path||'').trim();
    await sbReq('PATCH',`vinhos?id=eq.${v.id}`,{imagem_path:caminho});
    v.imagem_path=caminho;
    // A anterior deixa de servir para alguma coisa — fica lixo pago no
    // bucket. Falhar a apagá-la não estraga nada, por isso não trava.
    if(antigo&&antigo!==caminho)apagarObjeto(antigo);
    await assinarImagens();
    est.textContent='';
    renderLista();refrescarVinhoAberto();abrirFoto(v.id);
    if(tabAtiva==='locais')renderMapa();
    toast('Imagem guardada ✓');
  }catch(e){
    est.innerHTML=`<span style="color:var(--dg)">Não foi possível: ${esc(e.message)}</span>`;
  }
}
async function apagarObjeto(caminho){
  try{
    await sbFetch(`${SB_URL}/storage/v1/object/${BUCKET}/${caminho}`,
      {method:'DELETE',headers:{'apikey':SB_KEY}});
  }catch(e){}
}
async function apagarFotoPropria(){
  if(roGuard())return;
  const v=IDXV[FOTO_VINHO];if(!v)return;
  const caminho=String(v.imagem_path||'').trim();
  if(!caminho)return;
  if(!confirm('Remover a tua imagem deste vinho?\n\nVolta a aparecer a que a procura encontrou, ou a garrafa desenhada.'))return;
  try{
    await sbReq('PATCH',`vinhos?id=eq.${v.id}`,{imagem_path:''});
    v.imagem_path='';delete IMG_ASSINADA[v.id];
    apagarObjeto(caminho);
    renderLista();refrescarVinhoAberto();abrirFoto(v.id);
    if(tabAtiva==='locais')renderMapa();
    toast('Imagem removida');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}

function filtrarPorCasta(nome){
  fecharModal('modal-vinho');
  limparFiltros();
  F.casta=nome;
  const bts=document.querySelectorAll('.itabs .it');
  if(tabAtiva!=='detalhe')tab('detalhe',bts[1]);
  else renderFiltrados();
  toast('A mostrar vinhos com '+nome);
}

async function apagarVinho(id){
  if(roGuard())return;
  const v=IDXV[id];if(!v)return;
  const n=garrafasDe(id,false).length;
  if(!confirm(`Apagar "${v.nome}"?\n\nLeva com ele ${n} garrafa${n===1?'':'s'}, incluindo o registo de quando e onde foram bebidas. Isto não se desfaz.`))return;
  try{
    const foto=String(v.imagem_path||'').trim();
    await sbReq('DELETE',`vinhos?id=eq.${id}`);
    if(foto)apagarObjeto(foto);        // senão ficava um ficheiro órfão no bucket
    db.vinhos=db.vinhos.filter(x=>x.id!==id);
    db.garrafas=db.garrafas.filter(g=>g.vinho_id!==id);   // ON DELETE CASCADE do lado da BD
    reindexar();fecharModal('modal-vinho');renderLista();
    toast('Vinho apagado');
  }catch(e){toast('Não foi possível apagar: '+e.message,1);}
}

/* ── MODAL EDITAR / NOVO VINHO ─────────────────────────────────────
   O mesmo formulário serve para criar e para editar (id=0 é criar). Ao
   criar, pede também onde vai a primeira garrafa — um vinho sem garrafa
   nenhuma não aparece em lado nenhum e parecia que não tinha sido gravado. */
const TIPOS=['Tinto','Branco','Rosé','Espumante','Licoroso','Frisante'];
const ESTILOS=['','Maduro','Verde','Colheita Tardia','Palhete'];
const MENCOES=['','Reserva','Grande Reserva','Garrafeira','Colheita Selecionada','Vinhas Velhas','Superior','Grande Escolha'];
const CLASSIF=['','DOC','Vinho Regional','Vinho'];

function abrirNovoVinho(){
  if(roGuard())return;
  abrirEditarVinho(0);
}
function abrirEditarVinho(id){
  if(roGuard())return;
  const v=id?IDXV[id]:null;
  if(id&&!v)return;
  _iaExtraNovo=null;   // o que a procura trouxe é de UM formulário, não fica de um para o outro
  const o=(k,d)=>v?(v[k]==null?'':v[k]):(d==null?'':d);
  const opts=(arr,sel)=>arr.map(x=>`<option value="${esc(x)}"${String(sel)===String(x)?' selected':''}>${esc(x||'—')}</option>`).join('');
  const locOpts=db.locais.map(l=>`<option value="${l.id}">${esc(l.nome)}</option>`).join('');

  document.getElementById('modal-edit-in').innerHTML=`
    <div class="mtop"><h3>${id?'Editar vinho':'Novo vinho'}</h3>
      <button class="mx" onclick="fecharModal('modal-edit')">✕</button></div>

    <label>Nome</label>
    <input type="text" id="e-nome" value="${esc(o('nome'))}" placeholder="Quinta do Vallado Touriga Nacional">
    <div class="mrow">
      <div><label>Ano</label><input type="number" id="e-ano" inputmode="numeric" value="${esc(o('ano'))}" placeholder="2021"></div>
      <div><label>Produtor</label><input type="text" id="e-produtor" value="${esc(o('produtor'))}" placeholder="Quinta do Vallado"></div>
    </div>

    ${id?'':`<div class="aviso">Escreve o nome (e o ano, se souberes) e carrega em <b>Procurar informação</b>: a pesquisa preenche o resto — castas, região, tipo, nota do Vivino, preço médio e quando beber. Confirmas antes de gravar.</div>
      <button class="btn prim full" id="e-btn-ia" onclick="iaProcurarNovo()">🔎 Procurar informação</button>
      <div id="e-ia-estado"></div>`}

    <div class="mrow">
      <div><label>Tipo</label><select id="e-tipo">${opts(TIPOS,o('tipo','Tinto'))}</select></div>
      <div><label>Estilo</label><select id="e-estilo">${opts(ESTILOS,o('estilo'))}</select></div>
    </div>
    <div class="mrow">
      <div><label>Região</label><input type="text" id="e-regiao" value="${esc(o('regiao'))}" placeholder="Douro"></div>
      <div><label>Sub-região</label><input type="text" id="e-subregiao" value="${esc(o('sub_regiao'))}" placeholder="Cima Corgo"></div>
    </div>
    <div class="mrow">
      <div><label>Menção</label><select id="e-mencao">${opts(MENCOES,o('mencao'))}</select></div>
      <div><label>Classificação</label><select id="e-classificacao">${opts(CLASSIF,o('classificacao'))}</select></div>
    </div>

    <label>Castas <span style="text-transform:none;font-weight:400">— separadas por vírgula</span></label>
    <input type="text" id="e-castas" value="${esc((v&&v.castas||[]).join(', '))}" placeholder="Touriga Nacional, Touriga Franca">
    <div class="note">Uma só casta fica marcada como <b>monocasta</b>; duas ou mais, <b>várias castas</b>. Não é preciso escolher — sai da contagem.</div>

    <div class="mrow">
      <div><label>Estágio (meses)</label><input type="number" id="e-estagio" inputmode="numeric" value="${esc(o('estagio_meses'))}" placeholder="18"></div>
      <div><label>Álcool (%)</label><input type="text" id="e-teor" inputmode="decimal" value="${esc(o('teor'))}" placeholder="14.5"></div>
    </div>
    <label>Estágio (descrição)</label>
    <input type="text" id="e-estagio-txt" value="${esc(o('estagio_texto'))}" placeholder="18 meses em barrica de carvalho francês">

    <div class="mrow">
      <div><label>Beber a partir de</label><input type="number" id="e-beber-de" inputmode="numeric" value="${esc(o('beber_de'))}" placeholder="2026"></div>
      <div><label>Beber até</label><input type="number" id="e-beber-ate" inputmode="numeric" value="${esc(o('beber_ate'))}" placeholder="2034"></div>
    </div>
    <div class="mrow">
      <div><label>Preço médio (€)</label><input type="text" id="e-preco" inputmode="decimal" value="${esc(o('preco_medio'))}" placeholder="18.50"></div>
      <div><label>Nota Vivino</label><input type="text" id="e-vivino" inputmode="decimal" value="${esc(o('vivino_nota'))}" placeholder="4.1"></div>
    </div>
    <label>Link do Vivino</label>
    <input type="url" id="e-vivino-url" value="${esc(o('vivino_url'))}" placeholder="https://www.vivino.com/…">

    ${TEM_IMAGEM?`<label>Imagem do rótulo <span style="text-transform:none;font-weight:400">— link (opcional)</span></label>
    <input type="url" id="e-imagem" value="${esc(o('imagem_url'))}" placeholder="https://…/rotulo.jpg">
    <div class="note">O link da fotografia, não o da página da loja — e sem nenhum, a app desenha a garrafa com a cor do tipo e o ano no rótulo.</div>`:''}

    <label>As minhas notas</label>
    <textarea id="e-notas" placeholder="Onde comprei, para que ocasião guardei, o que achei…">${esc(o('notas'))}</textarea>

    ${id?'':`
      <div class="msec">Primeira garrafa</div>
      <div class="mrow">
        <div><label>Local</label><select id="e-local">${locOpts||'<option value="">(cria um local primeiro)</option>'}</select></div>
        <div><label>Quantas</label><input type="number" id="e-qtd" inputmode="numeric" value="1" min="1" max="60"></div>
      </div>
      <div class="mrow">
        <div><label>Prateleira</label><input type="text" id="e-prat" placeholder="Nível 3"></div>
        <div><label>Lugar</label><input type="text" id="e-lugar" placeholder="12"></div>
      </div>
      <div class="mrow">
        <div><label>Preço de compra (€)</label><input type="text" id="e-preco-compra" inputmode="decimal" placeholder="15.90"></div>
        <div><label>Comprada em</label><input type="date" id="e-comprado"></div>
      </div>`}

    <div class="macoes">
      <button class="btn prim" id="e-guardar" onclick="guardarVinho(${id})">${id?'Guardar':'Adicionar à garrafeira'}</button>
      <button class="btn ghost" onclick="fecharModal('modal-edit')">Cancelar</button>
    </div>`;
  abrirModal('modal-edit');
  setTimeout(()=>{const n=document.getElementById('e-nome');if(!id&&n)n.focus();},60);
}

function lerFormVinho(){
  const g=id=>{const e=document.getElementById(id);return e?e.value.trim():'';};
  const f={
    nome:g('e-nome'),
    ano:inteiro(g('e-ano')),
    produtor:g('e-produtor'),
    tipo:g('e-tipo')||'Tinto',
    estilo:g('e-estilo'),
    regiao:g('e-regiao'),
    sub_regiao:g('e-subregiao'),
    mencao:g('e-mencao'),
    classificacao:g('e-classificacao'),
    estagio_meses:inteiro(g('e-estagio')),
    estagio_texto:g('e-estagio-txt'),
    teor:num(g('e-teor')),
    beber_de:inteiro(g('e-beber-de')),
    beber_ate:inteiro(g('e-beber-ate')),
    preco_medio:num(g('e-preco')),
    vivino_nota:num(g('e-vivino')),
    vivino_url:g('e-vivino-url'),
    notas:g('e-notas'),
    _castas:g('e-castas').split(',').map(s=>s.trim()).filter(Boolean)
  };
  // Só entra no PATCH/POST se a coluna existir na BD (ver detetarImagem).
  if(TEM_IMAGEM)f.imagem_url=g('e-imagem');
  return f;
}

async function guardarVinho(id){
  if(roGuard())return;
  const f=lerFormVinho();
  if(!f.nome){toast('Falta o nome do vinho',1);return;}
  if(f.ano!=null&&(f.ano<1900||f.ano>2100)){toast('Ano fora do razoável',1);return;}
  const castas=f._castas;delete f._castas;
  // O formulário não tem campos para o resumo/notas de prova/link do Vivino:
  // a procura da IA deixou-os em `_iaExtraNovo` e é aqui que se juntam. Só na
  // CRIAÇÃO — a editar, quem manda nesses campos é o painel de confirmação.
  if(!id&&_iaExtraNovo)Object.assign(f,_iaExtraNovo);
  // Carimbo da gravação à mão — separado do carimbo da IA (`ai_atualizado_em`),
  // que só muda ao aceitar-se uma pesquisa. Só entra se a coluna existir
  // (ver `detetarAtualizado`).
  if(TEM_ATUALIZADO)f.atualizado_em=new Date().toISOString();

  const btn=document.getElementById('e-guardar');
  btn.disabled=true;btn.textContent='A guardar…';
  try{
    let vinhoId=id;
    if(id){
      await sbReq('PATCH',`vinhos?id=eq.${id}`,f);
      Object.assign(IDXV[id],f);
    }else{
      const r=await sbReq('POST','vinhos',[f],{'Prefer':'return=representation'});
      const novo=r[0];novo.castas=[];
      db.vinhos.push(novo);vinhoId=novo.id;reindexar();
    }
    // As castas passam pela função SQL: ela cria as que faltam e apaga as
    // que saíram numa transação só, e é ela que resolve duas pessoas a
    // gravar a mesma casta ao mesmo tempo (ON CONFLICT).
    await sbRpc('definir_castas',{p_vinho_id:vinhoId,p_nomes:castas});
    IDXV[vinhoId].castas=castas.slice().sort((a,b)=>a.localeCompare(b,'pt'));
    await recarregarCastas();

    if(!id){
      const qtd=Math.max(1,Math.min(60,inteiro(document.getElementById('e-qtd').value)||1));
      const localSel=document.getElementById('e-local');
      const base={
        vinho_id:vinhoId,
        local_id:localSel&&localSel.value?parseInt(localSel.value,10):null,
        prateleira:document.getElementById('e-prat').value.trim(),
        lugar:document.getElementById('e-lugar').value.trim(),
        preco_compra:num(document.getElementById('e-preco-compra').value),
        comprado_em:document.getElementById('e-comprado').value||null
      };
      // Várias garrafas iguais: só a primeira fica com o lugar escrito. Duas
      // garrafas no MESMO lugar é uma informação falsa sobre a garrafeira —
      // as outras ficam sem lugar, para se arrumarem depois.
      const linhas=[];
      for(let i=0;i<qtd;i++)linhas.push(Object.assign({},base,i?{lugar:''}:{}));
      const gr=await sbReq('POST','garrafas',linhas,{'Prefer':'return=representation'});
      (gr||[]).forEach(g=>db.garrafas.push(g));
      reindexar();
    }
    _iaExtraNovo=null;
    fecharModal('modal-edit');renderLista();refrescarVinhoAberto();
    if(tabAtiva==='locais')renderMapa();
    toast(id?'Guardado ✓':'Vinho adicionado ✓');
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    btn.disabled=false;btn.textContent=id?'Guardar':'Adicionar à garrafeira';
  }
}
// A lista de castas cresce quando se grava um vinho com uma casta nova — é
// dela que sai o filtro de castas, por isso tem de ser relida.
async function recarregarCastas(){
  try{db.castas=await sbReq('GET','castas?select=*&order=nome.asc')||[];}catch(e){}
}

/* ── CONSUMIR GARRAFA ──────────────────────────────────────────────
   Dar saída. O que interessa guardar é a data, ONDE foi bebida e a
   observação — é isso que responde ao "onde é que bebi aquela relíquia". */
function abrirConsumir(vinhoId,garrafaId){
  if(roGuard())return;
  const v=IDXV[vinhoId];if(!v)return;
  const gs=garrafasDe(vinhoId,true);
  if(!gs.length){toast('Já não há garrafas deste vinho',1);return;}
  const escolhida=garrafaId||gs[0].id;
  document.getElementById('modal-consumir-in').innerHTML=`
    <div class="mhero">
      <button class="mx" onclick="fecharModal('modal-consumir')">✕</button>
      <div class="mhero-in">
        <div class="mhero-g">${garrafaSVG(v)}${imagemDe(v)
          ?`<img src="${esc(imagemDe(v))}" alt="" onerror="this.remove()">`:''}</div>
        <div class="mhero-tx">
          <div class="mhero-k">Dar saída</div>
          <h3>${esc(v.nome)}</h3>
          <div class="mhero-s">${esc([v.produtor,v.ano,v.regiao].filter(Boolean).join(' · '))}</div>
        </div>
      </div>
    </div>

    ${gs.length>1?`<label>Qual garrafa</label>
      <select id="c-garrafa">${gs.map(g=>`<option value="${g.id}"${g.id===escolhida?' selected':''}>${esc(ondeEsta(g))}</option>`).join('')}</select>`
      :`<input type="hidden" id="c-garrafa" value="${escolhida}">
        <div class="mgar" style="margin-top:14px"><div class="g-onde"><b>📍 ${esc(ondeEsta(gs[0]))}</b></div></div>`}

    <label>Quando</label>
    <input type="date" id="c-data" value="${hoje()}">
    <label>Onde / com quem</label>
    <input type="text" id="c-local" placeholder="Jantar de anos, lá em casa">

    <label>Que tal era</label>
    <input type="hidden" id="c-aval" value="">
    <div class="stars" id="c-stars">
      ${[1,2,3,4,5].map(n=>`<button type="button" class="star" onclick="setAval(${n})" title="${n}">★</button>`).join('')}
    </div>
    <div class="stars-l" id="c-stars-l">Sem nota — toca numa estrela (e outra vez na mesma para tirar).</div>

    <label>Observações</label>
    <textarea id="c-nota" placeholder="Estava no ponto, ainda aguentava mais uns anos…"></textarea>

    <div class="macoes">
      <button class="btn prim" id="c-btn" onclick="confirmarConsumo(${vinhoId})">Dar saída</button>
      <button class="btn ghost" onclick="fecharModal('modal-consumir')">Cancelar</button>
    </div>`;
  abrirModal('modal-consumir');
}
/* As estrelas escrevem num <input type=hidden> com o id de sempre
   (`c-aval`), por isso `confirmarConsumo` não muda: continua a ler o
   `.value`. Antes isto era um <select> com "★★★☆☆" nas opções — dava uma
   lista de texto no telemóvel e ninguém percebia que era a nota. */
const AVAL_TXT=['','Fraquinho','Assim-assim','Bom','Muito bom','Do outro mundo'];
function setAval(n){
  const inp=document.getElementById('c-aval');
  const novo=(String(inp.value)===String(n))?'':String(n);
  inp.value=novo;
  document.querySelectorAll('#c-stars .star').forEach((b,i)=>b.classList.toggle('on',!!novo&&i<Number(novo)));
  document.getElementById('c-stars-l').textContent=
    novo?estrelas(Number(novo))+'  '+AVAL_TXT[Number(novo)]:'Sem nota — toca numa estrela (e outra vez na mesma para tirar).';
}
async function confirmarConsumo(vinhoId){
  if(roGuard())return;
  const gid=parseInt(document.getElementById('c-garrafa').value,10);
  const data=document.getElementById('c-data').value||hoje();
  const btn=document.getElementById('c-btn');
  btn.disabled=true;btn.textContent='A gravar…';
  try{
    // RPC e não PATCH: estado + data têm de entrar juntos (é o que o CHECK
    // `garrafas_consumo_chk` exige), e a função recusa consumir duas vezes a
    // mesma garrafa — o que um duplo toque conseguia fazer.
    await sbRpc('consumir_garrafa',{
      p_garrafa_id:gid,
      p_data:data,
      p_local:document.getElementById('c-local').value.trim(),
      p_nota:document.getElementById('c-nota').value.trim(),
      p_avaliacao:inteiro(document.getElementById('c-aval').value)
    });
    const g=db.garrafas.find(x=>x.id===gid);
    if(g)Object.assign(g,{estado:'consumida',consumido_em:data,
      consumo_local:document.getElementById('c-local').value.trim(),
      consumo_nota:document.getElementById('c-nota').value.trim(),
      consumo_avaliacao:inteiro(document.getElementById('c-aval').value)});
    fecharModal('modal-consumir');renderLista();refrescarVinhoAberto();
    if(tabAtiva==='locais')renderMapa();
    if(tabAtiva==='consumidos')renderConsumidos();
    toast('Saída registada 🍷');
  }catch(e){
    toast('Não foi possível: '+e.message,1);
    btn.disabled=false;btn.textContent='Dar saída';
  }
}
async function reporGarrafa(gid){
  if(roGuard())return;
  try{
    await sbRpc('repor_garrafa',{p_garrafa_id:gid});
    const g=db.garrafas.find(x=>x.id===gid);
    if(g)Object.assign(g,{estado:'na_garrafeira',consumido_em:null,consumo_local:'',consumo_nota:'',consumo_avaliacao:null});
    renderConsumidos();renderLista();refrescarVinhoAberto();
    toast('Garrafa reposta');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}

/* ── MODAL DA GARRAFA (mover / acrescentar / apagar) ───────────────── */
function abrirGarrafa(gid,vinhoId){
  if(roGuard())return;
  const g=gid?db.garrafas.find(x=>x.id===gid):null;
  const vid=g?g.vinho_id:vinhoId;
  const v=IDXV[vid];if(!v)return;
  const locOpts=db.locais.map(l=>
    `<option value="${l.id}"${g&&g.local_id===l.id?' selected':''}>${esc(l.nome)}</option>`).join('');
  document.getElementById('modal-garrafa-in').innerHTML=`
    <div class="mtop"><div><h3>${gid?'Mover garrafa':'Acrescentar garrafa'}</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome)} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-garrafa')">✕</button></div>
    <div class="mrow">
      <div><label>Local</label><select id="g-local">${locOpts||'<option value="">(cria um local primeiro)</option>'}</select></div>
      ${gid?'':'<div><label>Quantas</label><input type="number" id="g-qtd" value="1" min="1" max="60" inputmode="numeric"></div>'}
    </div>
    <div class="mrow">
      <div><label>Prateleira</label><input type="text" id="g-prat" value="${esc(g?g.prateleira:'')}" placeholder="Nível 3"></div>
      <div><label>Lugar</label><input type="text" id="g-lugar" value="${esc(g?g.lugar:'')}" placeholder="12"></div>
    </div>
    <div class="mrow">
      <div><label>Formato</label><input type="text" id="g-formato" value="${esc(g?g.formato:'0,75 L')}"></div>
      <div><label>Preço de compra (€)</label><input type="text" id="g-preco" inputmode="decimal" value="${esc(g&&g.preco_compra!=null?g.preco_compra:'')}"></div>
    </div>
    <label>Comprada em</label>
    <input type="date" id="g-comprado" value="${esc(g&&g.comprado_em?g.comprado_em:'')}">
    <div class="macoes">
      <button class="btn prim" id="g-btn" onclick="guardarGarrafa(${gid||0},${vid})">Guardar</button>
      ${gid?`<button class="btn danger" onclick="apagarGarrafa(${gid})">🗑 Apagar</button>`:''}
      <button class="btn ghost" onclick="fecharModal('modal-garrafa')">Cancelar</button>
    </div>`;
  abrirModal('modal-garrafa');
}
async function guardarGarrafa(gid,vinhoId){
  if(roGuard())return;
  const locSel=document.getElementById('g-local');
  const dados={
    local_id:locSel&&locSel.value?parseInt(locSel.value,10):null,
    prateleira:document.getElementById('g-prat').value.trim(),
    lugar:document.getElementById('g-lugar').value.trim(),
    formato:document.getElementById('g-formato').value.trim()||'0,75 L',
    preco_compra:num(document.getElementById('g-preco').value),
    comprado_em:document.getElementById('g-comprado').value||null
  };
  const btn=document.getElementById('g-btn');
  btn.disabled=true;btn.textContent='A guardar…';
  try{
    if(gid){
      await sbReq('PATCH',`garrafas?id=eq.${gid}`,dados);
      Object.assign(db.garrafas.find(x=>x.id===gid),dados);
    }else{
      const qtd=Math.max(1,Math.min(60,inteiro(document.getElementById('g-qtd').value)||1));
      const linhas=[];
      for(let i=0;i<qtd;i++)linhas.push(Object.assign({vinho_id:vinhoId},dados,i?{lugar:''}:{}));
      const r=await sbReq('POST','garrafas',linhas,{'Prefer':'return=representation'});
      (r||[]).forEach(g=>db.garrafas.push(g));
    }
    reindexar();fecharModal('modal-garrafa');renderLista();refrescarVinhoAberto();
    if(tabAtiva==='locais')renderMapa();
    toast('Guardado ✓');
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    btn.disabled=false;btn.textContent='Guardar';
  }
}
async function apagarGarrafa(gid){
  if(roGuard())return;
  if(!confirm('Apagar esta garrafa da lista?\n\nSe ela foi BEBIDA, fecha isto e usa "Consumir" — assim fica no histórico em vez de desaparecer.'))return;
  try{
    await sbReq('DELETE',`garrafas?id=eq.${gid}`);
    db.garrafas=db.garrafas.filter(x=>x.id!==gid);
    reindexar();fecharModal('modal-garrafa');renderLista();refrescarVinhoAberto();
    if(tabAtiva==='locais')renderMapa();
    toast('Garrafa apagada');
  }catch(e){toast('Não foi possível apagar: '+e.message,1);}
}

/* ── IA: PROCURAR INFORMAÇÃO DO VINHO ──────────────────────────────
   Quem procura é a Edge Function `vinho-info` (ficheiro vinho-info.ts na
   raiz do repo, deploy à parte). Ela é que fala com o Gemini com pesquisa
   Google ligada — sem grounding o modelo inventa notas do Vivino e preços
   de memória, que é exatamente o que não se quer numa base de dados.

   A procura corre em SEGUNDO PLANO (garrafeira.analises): a pesquisa demora
   mais do que um pedido HTTP aguenta (o browser/iOS corta perto dos 60s) e,
   no telemóvel, bloquear o ecrã a meio matava a chamada. A função cria uma
   linha 'pendente', responde já com o id, e continua com
   EdgeRuntime.waitUntil; aqui faz-se polling a essa linha.

   NADA é gravado sem confirmação: o resultado abre num painel campo a campo,
   com o que está agora ao lado do que a IA propõe, e só entra o que ficar
   marcado. As datas e os preços mexem em decisões — e a leitura é de uma IA.

   E nada é procurado DUAS vezes sem confirmação: se já se procurou este
   vinho nos últimos 30 dias, pergunta-se antes de gastar outra chamada
   (`iaUltimaProcura`/`iaConfirmarRepetir`). */

const IA_TIMEOUT_MS=150000;   // desistir de esperar (a função tem 110s de orçamento)
const IA_INTERVALO_MS=2500;

// Deixa rasto ANTES de chamar: é assim que se apanha o caso em que o pedido
// nem saiu do browser (sem rede, CORS, sessão morta). Tolerante — se a
// tabela não existir, engole e segue.
async function iaLog(estado,detalhe){
  try{
    await sbReq('POST','sync_log',[{origem:'app',acao:'vinho-info',estado,quem:EU.email,detalhe}],
      {'Prefer':'return=minimal'});
  }catch(e){}
}

/* Chama a função e espera pelo resultado. Devolve o objeto da IA, ou
   levanta um erro com uma mensagem que se possa mostrar a alguém. */
async function iaPedir(pedido,vinhoId){
  await iaLog('pedido',{pedido,vinho_id:vinhoId||null});
  let r;
  try{
    r=await sbFetch(`${SB_URL}/functions/v1/vinho-info`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify(Object.assign({assincrono:true,vinhoId:vinhoId||null},pedido))
    });
  }catch(e){
    await iaLog('erro',{passo:'fetch',erro:String(e.message)});
    throw new Error('Não foi possível falar com o servidor. Sem rede?');
  }
  let d={};try{d=await r.json();}catch(_){}
  if(!r.ok){
    await iaLog('erro',{passo:'http',status:r.status,erro:d.error||''});
    if(r.status===404)throw new Error('A função `vinho-info` ainda não está publicada no Supabase. Ver o README.');
    throw new Error(d.error||('O servidor respondeu HTTP '+r.status));
  }
  // Sem `id` a função respondeu no modo antigo (síncrono) — já traz tudo.
  if(!d.id)return d;
  return await iaEsperar(d.id);
}
async function iaEsperar(id){
  const fim=Date.now()+IA_TIMEOUT_MS;
  while(Date.now()<fim){
    await new Promise(s=>setTimeout(s,IA_INTERVALO_MS));
    let rows;
    try{
      rows=await sbReq('GET',`analises?id=eq.${id}&select=estado,resultado,erro`);
    }catch(e){continue;}   // um soluço de rede a meio não deita a espera abaixo
    const a=(rows||[])[0];
    if(!a)continue;
    if(a.estado==='concluido')return a.resultado||{};
    if(a.estado==='erro')throw new Error(a.erro||'a procura falhou');
  }
  throw new Error('A procura está a demorar demasiado. Ela continua a correr no servidor — tenta outra vez daqui a um bocado.');
}

// Do detalhe de um vinho que já existe.
/* ESCOLHER O QUE PROCURAR, antes de procurar.
   Pedir os 22 campos de uma vez faz o modelo andar atrás de tudo e voltar
   com meia dúzia de coisas mornas; pedir só o que falta concentra a
   pesquisa (e a função corta do JSON o que não foi pedido, por isso o ecrã
   de confirmação também fica só com isso).

   Vêm marcados os campos VAZIOS — a mesma regra do ecrã de confirmação:
   o que já lá está só se mexe por decisão de quem está a ver. */
function iaValorAtual(v,k){
  if(k==='castas')return (v.castas||[]).length?v.castas.join(', '):'';
  return v[k]==null||v[k]===''?'':String(v[k]);
}
function iaEscolher(vinhoId){
  if(roGuard())return;
  const v=IDXV[vinhoId];if(!v)return;
  const linhas=IA_CAMPOS.map(c=>{
    const tem=!!iaValorAtual(v,c.k);
    return `<label class="ia-esc">
      <input type="checkbox" class="ia-esc-c" value="${esc(c.k)}"${tem?'':' checked'}>
      <span>${esc(c.rot)}${tem?'<i>já tem</i>':''}</span>
    </label>`;
  }).join('');
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><div><h3>🔎 Procurar informação</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome)} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>

    <div class="aviso">Escolhe o que queres procurar. <b>Quanto menos pedires, melhor a procura</b> —
      o modelo concentra-se nisso em vez de andar atrás de tudo. Já vêm marcados os campos vazios.</div>

    <div class="ia-escbar">
      <button class="mini" onclick="iaEscTodos(true)">Marcar tudo</button>
      <button class="mini" onclick="iaEscTodos(false)">Desmarcar</button>
      <span class="note" id="ia-esc-n"></span>
    </div>
    <div class="ia-escs" onchange="iaEscContar()">${linhas}</div>

    <div class="macoes">
      <button class="btn prim" id="ia-esc-btn" onclick="iaProcurar(${vinhoId})">Procurar</button>
      <button class="btn ghost" onclick="fecharModal('modal-ia')">Cancelar</button>
    </div>`;
  abrirModal('modal-ia');
  iaEscContar();
}
function iaEscTodos(marcar){
  document.querySelectorAll('.ia-esc-c').forEach(e=>e.checked=marcar);
  iaEscContar();
}
function iaEscSelecionados(){
  return [...document.querySelectorAll('.ia-esc-c:checked')].map(e=>e.value);
}
function iaEscContar(){
  const n=iaEscSelecionados().length, tot=IA_CAMPOS.length;
  const et=document.getElementById('ia-esc-n');
  if(et)et.textContent=n===tot?'todos os campos':`${n} de ${tot} campos`;
  const b=document.getElementById('ia-esc-btn');
  if(b){b.disabled=!n;b.textContent=n?`🔎 Procurar ${n===tot?'tudo':n+(n===1?' campo':' campos')}`:'Escolhe pelo menos um';}
}

/* ── JÁ SE PROCUROU ISTO HÁ POUCO? ─────────────────────────────────
   Cada procura é uma chamada ao Gemini com pesquisa Google ligada — custa
   dinheiro de verdade, e a ficha de um vinho não muda de semana para
   semana. Por isso, antes de repetir a procura ao MESMO vinho dentro de
   `IA_AVISO_DIAS`, pergunta-se se é mesmo isso que se quer.

   Onde está escrito que já se procurou (fica a data mais recente das duas):
   · `analises` — a linha de CADA procura, mesmo quando não se aceitou nada
     no fim. É o registo exato do que se gastou, mas a RLS só deixa ver as
     MINHAS (o admin vê todas), por isso não chega sozinha;
   · `vinhos.ai_atualizado_em` — o carimbo que fica quando alguém aceitou
     alguma coisa. Vê-se sempre, seja de quem for: é o que apanha a procura
     feita por OUTRO editor. Mas só vale quando foi a APP a escrevê-lo, e
     isso lê-se no `ai_modelo`: a app só lá põe o que a Edge Function
     devolve (`gemini-…`). Os outros valores que essa coluna tem vieram da
     importação à mão ("pesquisa web (Claude) + complemento (ChatGPT)",
     "…confirmação no rótulo (Barrona)") — ficha preenchida, sim, mas sem
     um cêntimo gasto em Gemini. Sem esta condição o aviso aparecia nos 85
     vinhos logo no primeiro dia, e um aviso que aparece sempre não se lê.
   Se a consulta falhar, não se avisa e segue-se em frente — um soluço de
   rede não pode ser o que impede alguém de procurar. */
const IA_AVISO_DIAS=30;

async function iaUltimaProcura(vinhoId){
  const v=IDXV[vinhoId]||{};
  const cands=[];
  try{
    const rows=await sbReq('GET',`analises?vinho_id=eq.${vinhoId}&estado=eq.concluido`+
      `&select=criado_em,quem&order=criado_em.desc&limit=1`);
    const a=(rows||[])[0];
    if(a&&a.criado_em)cands.push({quando:a.criado_em,
      minha:String(a.quem||'').toLowerCase()===String(EU.email||'').toLowerCase()});
  }catch(e){}
  if(v.ai_atualizado_em&&/^gemini/i.test(String(v.ai_modelo||'')))
    cands.push({quando:v.ai_atualizado_em,minha:false});
  if(!cands.length)return null;
  cands.sort((x,y)=>new Date(y.quando)-new Date(x.quando));
  const u=cands[0];
  const dias=(Date.now()-new Date(u.quando).getTime())/86400000;
  return dias<IA_AVISO_DIAS?u:null;
}

function iaConfirmarRepetir(vinhoId,ult){
  const v=IDXV[vinhoId]||{};
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><div><h3>Já se procurou este vinho</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome||'')} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>

    <div class="aviso">${ult.minha
      ? 'Utilizaste a pesquisa para este vinho pela última vez em'
      : 'A pesquisa para este vinho foi utilizada pela última vez em'}
      <b>${esc(dataHoraLocal(ult.quando))}</b>. Pretendes fazer novamente a pesquisa?</div>
    <div class="note" style="margin-top:8px">A ficha de um vinho raramente muda de um mês para o
      outro — se foi há pouco, é provável que volte o mesmo.</div>

    <div class="macoes">
      <button class="btn prim" onclick="iaArrancar(${vinhoId})">Procurar à mesma</button>
      <button class="btn ghost" onclick="fecharModal('modal-ia')">Cancelar</button>
    </div>`;
  abrirModal('modal-ia');
}

// Os campos escolhidos no seletor, guardados enquanto se responde ao aviso:
// nessa altura o seletor já não está no ecrã para se lhe perguntar outra vez.
let IA_ESC=null;

async function iaProcurar(vinhoId){
  if(roGuard())return;
  const v=IDXV[vinhoId];if(!v)return;
  // Se o seletor está aberto, é dele que vem a lista; se alguém chamar isto
  // de outro sítio, procura-se tudo (que era o comportamento de sempre).
  const escolhidos=iaEscSelecionados();
  IA_ESC=escolhidos.length&&escolhidos.length<IA_CAMPOS.length?escolhidos:null;
  const btn=document.getElementById('ia-esc-btn');
  if(btn){btn.disabled=true;btn.textContent='A ver…';}
  const ult=await iaUltimaProcura(vinhoId);
  if(ult){iaConfirmarRepetir(vinhoId,ult);return;}
  iaArrancar(vinhoId);
}

// A procura em si. Separada do botão porque pelo meio pode entrar o aviso
// de "já se procurou isto há pouco" — e é daí que ela volta a arrancar.
async function iaArrancar(vinhoId){
  if(roGuard())return;
  const v=IDXV[vinhoId];if(!v)return;
  iaMostrarEspera(v.nome+(v.ano?' '+v.ano:''));
  try{
    const pedido={nome:v.nome,ano:v.ano,produtor:v.produtor,regiao:v.regiao};
    if(IA_ESC)pedido.campos=IA_ESC;
    const res=await iaPedir(pedido,vinhoId);
    iaMostrarResultado(res,vinhoId);
  }catch(e){iaMostrarErro(e.message);}
}
// Do formulário de "novo vinho": preenche os campos em vez de gravar.
async function iaProcurarNovo(){
  const nome=document.getElementById('e-nome').value.trim();
  if(!nome){toast('Escreve primeiro o nome do vinho',1);document.getElementById('e-nome').focus();return;}
  const ano=inteiro(document.getElementById('e-ano').value);
  const btn=document.getElementById('e-btn-ia');
  const est=document.getElementById('e-ia-estado');
  btn.disabled=true;btn.textContent='🔎 A procurar…';
  est.innerHTML='<div class="note" style="margin-top:8px">A pesquisar na net. Pode levar até dois minutos — podes ir fazendo o resto.</div>';
  try{
    const res=await iaPedir({nome,ano,produtor:document.getElementById('e-produtor').value.trim()},null);
    iaPreencherForm(res);
    est.innerHTML=`<div class="note" style="margin-top:8px;color:var(--vd)">✓ Preenchido com o que se encontrou${res.fontes&&res.fontes.length?' ('+res.fontes.length+' fontes)':''}. Confere antes de gravar.</div>`;
  }catch(e){
    est.innerHTML=`<div class="erro">${esc(e.message)}</div>`;
  }
  btn.disabled=false;btn.textContent='🔎 Procurar informação';
}

/* Campos que a IA pode trazer, na ordem em que fazem sentido a ler.
   `rot` é o rótulo; `fmt` só existe onde o valor cru não se lê bem. */
const IA_CAMPOS=[
  {k:'produtor',rot:'Produtor'},
  {k:'ano',rot:'Ano'},
  {k:'tipo',rot:'Tipo'},
  {k:'estilo',rot:'Estilo'},
  {k:'regiao',rot:'Região'},
  {k:'sub_regiao',rot:'Sub-região'},
  {k:'mencao',rot:'Menção'},
  {k:'classificacao',rot:'Classificação'},
  {k:'castas',rot:'Castas',fmt:v=>Array.isArray(v)?v.join(', '):String(v||'')},
  {k:'teor',rot:'Álcool (%)'},
  {k:'estagio_meses',rot:'Estágio (meses)'},
  {k:'estagio_texto',rot:'Estágio'},
  {k:'vivino_nota',rot:'Nota Vivino'},
  {k:'vivino_avaliacoes',rot:'Avaliações Vivino'},
  {k:'preco_medio',rot:'Preço médio (€)'},
  {k:'beber_de',rot:'Beber a partir de'},
  {k:'beber_ate',rot:'Beber até'},
  {k:'notas_prova',rot:'Notas de prova'},
  {k:'harmonizacao',rot:'Harmoniza com'},
  {k:'ai_resumo',rot:'Resumo'},
  {k:'vivino_url',rot:'Link do Vivino'},
  {k:'imagem_url',rot:'Imagem do rótulo'}
];

function iaMostrarEspera(titulo){
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><h3>🔎 A procurar</h3><button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    <div class="note" style="margin-top:6px">${esc(titulo)}</div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:20px">
      <div class="gl-spin" style="border-color:var(--vhp);border-top-color:var(--vh);width:22px;height:22px"></div>
      <div class="note">A pesquisar na net e a ler o que se encontra. Pode levar até dois minutos.</div>
    </div>
    <div class="aviso">Podes fechar esta janela — a procura continua no servidor. Só não fica gravada sem tu confirmares.</div>`;
  abrirModal('modal-ia');
}
function iaMostrarErro(msg){
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><h3>Não deu</h3><button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    <div class="erro">${esc(msg)}</div>
    <div class="macoes"><button class="btn ghost" onclick="fecharModal('modal-ia')">Fechar</button></div>`;
  abrirModal('modal-ia');
}

let IA_RES=null, IA_VINHO=null;
function iaMostrarResultado(res,vinhoId){
  IA_RES=res||{};IA_VINHO=vinhoId;
  const v=IDXV[vinhoId]||{};
  const atual=k=>k==='castas'?(v.castas||[]).join(', '):(v[k]==null?'':String(v[k]));

  const linhas=IA_CAMPOS.map(c=>{
    let novo=IA_RES[c.k];
    if(novo==null||novo===''||(Array.isArray(novo)&&!novo.length))return '';
    const txt=c.fmt?c.fmt(novo):String(novo);
    const ant=atual(c.k);
    if(chave(ant)===chave(txt))return '';                     // já lá está igual
    // Marcado por omissão só o que está VAZIO. Substituir o que alguém
    // escreveu à mão por uma leitura automática tem de ser um clique
    // consciente, não o comportamento normal.
    const vazio=!ant;
    return `<div class="ia-linha">
      <input type="checkbox" id="ia-${c.k}"${vazio?' checked':''}>
      <label for="ia-${c.k}" class="ia-campo" style="margin:0;text-transform:none;letter-spacing:0;font-weight:400;color:var(--tx)">
        <b>${esc(c.rot)}</b>
        ${ant?`<span class="ia-antes">${esc(ant)}</span> → `:''}${esc(txt)}
      </label>
    </div>`;
  }).filter(Boolean).join('');

  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><div><h3>O que se encontrou</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome||'')} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>

    ${linhas?`<div class="note" style="margin-top:10px">Só entra o que ficar marcado. Já vêm marcados os campos que estavam <b>vazios</b>; para trocar o que já lá estava, marca à mão.</div>
      <div style="margin-top:8px">${linhas}</div>
      <div class="macoes">
        <button class="btn prim" id="ia-btn" onclick="iaAplicar()">Guardar o que está marcado</button>
        <button class="btn ghost" onclick="iaTodos(true)">Marcar tudo</button>
        <button class="btn ghost" onclick="fecharModal('modal-ia')">Cancelar</button>
      </div>`
    :`<div class="note" style="margin-top:14px">A procura não trouxe nada de novo — o que está na ficha já bate certo com o que se encontrou.</div>
      <div class="macoes"><button class="btn ghost" onclick="fecharModal('modal-ia')">Fechar</button></div>`}

    ${res.fontes&&res.fontes.length?`<div class="ia-fontes">Fontes: ${
      res.fontes.map(f=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}</div>`:''}
    <div class="ia-fontes"><i>${res.pesquisa===false
      ? '⚠️ Isto saiu da memória do modelo, sem pesquisa na net — confere tudo antes de aceitar.'
      : 'Leitura automática de páginas da net. Vale como ponto de partida, não como certeza.'}</i></div>`;
  abrirModal('modal-ia');
}
function iaTodos(marcar){
  IA_CAMPOS.forEach(c=>{const e=document.getElementById('ia-'+c.k);if(e)e.checked=marcar;});
}

async function iaAplicar(){
  if(roGuard())return;
  const patch={},v=IDXV[IA_VINHO];
  if(!v)return;
  let castasNovas=null;
  IA_CAMPOS.forEach(c=>{
    const e=document.getElementById('ia-'+c.k);
    if(!e||!e.checked)return;
    const val=IA_RES[c.k];
    if(c.k==='castas'){castasNovas=Array.isArray(val)?val:String(val).split(',').map(s=>s.trim()).filter(Boolean);return;}
    patch[c.k]=val;
  });
  if(!Object.keys(patch).length&&!castasNovas){toast('Não marcaste nada');return;}

  // Carimbo da procura: fica sempre, mesmo que só se tenha aceitado um
  // campo. É o que deixa saber, daqui a um ano, de onde veio aquilo.
  patch.ai_atualizado_em=new Date().toISOString();
  if(IA_RES.modelo)patch.ai_modelo=IA_RES.modelo;
  if(IA_RES.fontes)patch.ai_fontes=IA_RES.fontes;

  const btn=document.getElementById('ia-btn');
  if(btn){btn.disabled=true;btn.textContent='A guardar…';}
  try{
    await sbReq('PATCH',`vinhos?id=eq.${IA_VINHO}`,patch);
    Object.assign(v,patch);
    if(castasNovas){
      await sbRpc('definir_castas',{p_vinho_id:IA_VINHO,p_nomes:castasNovas});
      v.castas=castasNovas.slice().sort((a,b)=>a.localeCompare(b,'pt'));
      await recarregarCastas();
    }
    fecharModal('modal-ia');renderLista();refrescarVinhoAberto();
    toast('Ficha atualizada ✓');
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    if(btn){btn.disabled=false;btn.textContent='Guardar o que está marcado';}
  }
}

// No formulário de vinho novo não há nada gravado para comparar: escreve-se
// só nos campos que estão VAZIOS, para não apagar o que a pessoa acabou de
// escrever à mão enquanto a procura corria.
function iaPreencherForm(res){
  const por=(id,val)=>{
    const e=document.getElementById(id);
    if(!e||val==null||val===''||(Array.isArray(val)&&!val.length))return;
    if(e.tagName==='SELECT'){
      const ok=[...e.options].some(o=>o.value===String(val));
      if(ok&&!e.value)e.value=String(val);
      return;
    }
    if(!e.value.trim())e.value=Array.isArray(val)?val.join(', '):String(val);
  };
  por('e-produtor',res.produtor);por('e-ano',res.ano);
  por('e-tipo',res.tipo);por('e-estilo',res.estilo);
  por('e-regiao',res.regiao);por('e-subregiao',res.sub_regiao);
  por('e-mencao',res.mencao);por('e-classificacao',res.classificacao);
  por('e-castas',res.castas);
  por('e-estagio',res.estagio_meses);por('e-estagio-txt',res.estagio_texto);
  por('e-teor',res.teor);
  por('e-beber-de',res.beber_de);por('e-beber-ate',res.beber_ate);
  por('e-preco',res.preco_medio);por('e-vivino',res.vivino_nota);
  por('e-imagem',res.imagem_url);
  // O resumo e as notas de prova só entram quando o vinho for gravado (o
  // formulário não tem campos para eles) — ficam aqui à espera disso.
  _iaExtraNovo={
    notas_prova:res.notas_prova||'',harmonizacao:res.harmonizacao||'',
    ai_resumo:res.ai_resumo||'',vivino_url:res.vivino_url||'',
    vivino_avaliacoes:res.vivino_avaliacoes||null,
    ai_fontes:res.fontes||null,ai_modelo:res.modelo||'',
    ai_atualizado_em:new Date().toISOString()
  };
}

/* ── AUTH (SUPABASE) ───────────────────────────────────────────────
   Mesmo fluxo do Goals/FestasBV: login → confirmar que o email está em
   `allowed_users` → se não estiver, ecrã "sem acesso" com "Solicitar
   acesso" → o admin aprova em Definições › Utilizadores. */
function sbRedirectUrl(){return window.location.origin+window.location.pathname;}
function sbLimparHash(){
  history.replaceState(null,'',window.location.pathname+window.location.search.replace(/[?&](access_token|refresh_token|expires_at|expires_in|token_hash|type|error|error_code|error_description)=[^&]*/g,'').replace(/^&/,'?'));
}
function sbAuthStatus(id,msg,cor){
  const e=document.getElementById(id);
  if(!e)return;
  e.style.display='block';e.textContent=msg;e.style.color=cor||'var(--mu)';
}
function sbLinkFalhou(cod){
  sbLimparHash();sbMostrarLogin();
  sbAuthStatus('login-status',
    'Esse link já não serve'+(cod?` (${cod})`:'')+'. Os scanners de segurança do email gastam-nos às vezes antes de lá chegares — pede outro e usa o CÓDIGO de 6 dígitos em vez do link.','var(--dg)');
  sbMostrarCaixaCodigo();
}
async function sbTratarHashAuth(){
  const hs=new URLSearchParams((window.location.hash||'').substring(1));
  const qs=new URLSearchParams(window.location.search||'');
  const g=k=>hs.get(k)||qs.get(k);
  const recovery=g('type')==='recovery';

  if(g('error')||g('error_code')){
    const cod=(g('error_code')||'')+' '+(g('error_description')||'');
    if(/expired|invalid|used/i.test(cod)){sbLinkFalhou(g('error_code')||'');return true;}
    sbLimparHash();sbMostrarLogin();
    sbAuthStatus('login-status',g('error_description')||'Não foi possível concluir a autenticação.','var(--dg)');
    return true;
  }
  const token_hash=g('token_hash');
  if(token_hash){
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:g('type')||'recovery',token_hash})
    });
    if(!r.ok){let d={};try{d=await r.json();}catch(_){}sbLinkFalhou(d.error_code||d.msg||('HTTP '+r.status));return true;}
    sbGuardarSessaoDeVerify(await r.json());
    sbLimparHash();
    if(recovery){sbMostrarNovaPass();return true;}
    await sbAposLogin();return true;
  }
  const access_token=g('access_token');
  if(!access_token)return false;
  const refresh_token=g('refresh_token');
  const expires_at=parseInt(g('expires_at'))||Math.floor(Date.now()/1000)+(parseInt(g('expires_in'))||3600);
  const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${access_token}`}});
  if(!r.ok){sbLinkFalhou('HTTP '+r.status);return true;}
  sbSaveSession({access_token,refresh_token,expires_at,user:await r.json()});
  sbLimparHash();
  if(recovery){sbMostrarNovaPass();return true;}
  await sbAposLogin();return true;
}
function sbGuardarSessaoDeVerify(d){
  sbSaveSession({access_token:d.access_token,refresh_token:d.refresh_token,
    expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),user:d.user});
}
function sbMostrarLogin(){
  document.getElementById('page-login').style.display='flex';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  if(window.glEsconderSplash)window.glEsconderSplash();
}
function sbMostrarNovaPass(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='flex';
  const sub=document.getElementById('nova-pass-sub');
  if(sub&&_sbSession&&_sbSession.user)sub.textContent=`Escolhe uma password nova para ${_sbSession.user.email}.`;
  if(window.glEsconderSplash)window.glEsconderSplash();
}

async function sbAposLogin(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  const email=_sbSession.user.email;

  // O acesso confirma-se lendo a PRÓPRIA linha (a policy `au_sel` só deixa
  // ver a nossa) — não é a UI a decidir, é a BD a devolver ou não a linha.
  // O admin pode não estar na lista: is_allowed() dá-lhe acesso na mesma, e
  // é por isso que o teste é "linha OU sou o admin conhecido".
  let data=null;
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,{headers:sbHeaders()});
    if(r.ok)data=await r.json();
  }catch(e){}
  let temAcesso=Array.isArray(data)&&data.length>0;
  if(!temAcesso){
    // Pode ser o admin que ainda não se pôs na lista: se conseguir ler a
    // config (só is_allowed() consegue), tem acesso na mesma.
    try{
      const c=await sbReq('GET','config?select=chave&limit=1');
      temAcesso=Array.isArray(c)&&c.length>0;
    }catch(e){}
  }
  if(!temAcesso){
    document.getElementById('page-sem-acesso').style.display='flex';
    document.getElementById('sem-acesso-email').textContent=`Sessão iniciada como ${email}. Esta conta ainda não tem acesso à garrafeira.`;
    if(window.glEsconderSplash)window.glEsconderSplash();
    return;
  }
  document.getElementById('page-sem-acesso').style.display='none';

  try{
    await carregar();
  }catch(e){
    toast('Erro a carregar: '+e.message,1);
    if(window.glEsconderSplash)window.glEsconderSplash();
    return;
  }
  renderLista();renderCfg();restaurarTab();
  if(window.glEsconderSplash)window.glEsconderSplash();
}

async function sbLoginGoogle(){
  window.location.href=`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(sbRedirectUrl())}`;
}
async function sbLoginEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  sbAuthStatus('login-status','A entrar…');
  try{
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{method:'POST',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){sbAuthStatus('login-status',d.error_description||d.msg||'Erro ao entrar.','var(--dg)');return;}
    sbSaveSession({access_token:d.access_token,refresh_token:d.refresh_token,
      expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),user:d.user});
    await sbAposLogin();
  }catch(e){sbAuthStatus('login-status','Erro de ligação.','var(--dg)');}
}
async function sbRegistarEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  sbAuthStatus('login-status','A criar conta…');
  try{
    const r=await fetch(`${SB_URL}/auth/v1/signup`,{method:'POST',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){sbAuthStatus('login-status',d.error_description||d.msg||'Erro ao criar conta.','var(--dg)');return;}
    // O login (auth.users) é PARTILHADO por todo o projeto Supabase — Goals,
    // FestasBV, SplitBill e esta. Um email já registado noutra app faz o
    // GoTrue devolver 200 sem enviar confirmação nenhuma, mas com
    // identities:[]. Sem esta leitura, a pessoa ficava à espera de um email
    // que nunca vinha.
    if(d.user&&Array.isArray(d.user.identities)&&d.user.identities.length===0){
      sbAuthStatus('login-status','Esta conta já existe (por ex., já tens login no Goals). Não é preciso criar outra — carrega em "Entrar" com o mesmo email e password.','var(--dg)');
      return;
    }
    sbAuthStatus('login-status','Conta criada! Confirma o email e volta a entrar.','var(--vd)');
  }catch(e){sbAuthStatus('login-status','Erro de ligação.','var(--dg)');}
}
async function sbRecuperarPassword(){
  const email=document.getElementById('login-email').value.trim();
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve primeiro o teu email aqui em cima e volta a tocar.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  sbAuthStatus('login-status','A enviar email…');
  try{
    const r=await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(sbRedirectUrl())}`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email})});
    if(r.status===429){sbAuthStatus('login-status','Já foi pedido um email há pouco. Espera uns minutos.','var(--dg)');return;}
    if(!r.ok){let d={};try{d=await r.json();}catch(_){}
      sbAuthStatus('login-status',d.error_description||d.msg||'Não foi possível enviar o email.','var(--dg)');return;}
    sbAuthStatus('login-status','Se houver conta com esse email, chega já o link e o código. Vê também o spam.','var(--vd)');
    sbMostrarCaixaCodigo();
  }catch(e){sbAuthStatus('login-status','Erro de ligação.','var(--dg)');}
}
function sbMostrarCaixaCodigo(){
  const b=document.getElementById('login-codigo');if(b)b.style.display='';
}
async function sbVerificarCodigo(){
  const email=document.getElementById('login-email').value.trim();
  const token=document.getElementById('login-cod').value.replace(/\s/g,'');
  if(!email||!email.includes('@')){sbAuthStatus('login-status','Escreve também o email — o código é confirmado com ele.','var(--dg)');return;}
  if(!token){sbAuthStatus('login-status','Escreve o código que veio no email.','var(--dg)');return;}
  const btn=document.getElementById('btn-login-cod');
  btn.disabled=true;btn.textContent='A confirmar…';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{method:'POST',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:'recovery',email,token})});
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      const msg=d.error_description||d.msg||'';
      sbAuthStatus('login-status',(!msg||/expired|invalid|token/i.test(msg))
        ?'Código errado ou já expirado. Confirma os dígitos ou pede outro email.':msg,'var(--dg)');
      btn.disabled=false;btn.textContent='Confirmar código';return;
    }
    sbGuardarSessaoDeVerify(await r.json());
    document.getElementById('login-cod').value='';
    btn.disabled=false;btn.textContent='Confirmar código';
    sbMostrarNovaPass();
  }catch(e){
    sbAuthStatus('login-status','Erro de ligação.','var(--dg)');
    btn.disabled=false;btn.textContent='Confirmar código';
  }
}
function sbValidarPass(p1,p2){
  if(p1.length<6)return 'A password tem de ter pelo menos 6 caracteres.';
  if(p1!==p2)return 'As duas passwords não são iguais.';
  return '';
}
async function sbTrocarPassword(password){
  let r;
  try{
    r=await sbFetch(`${SB_URL}/auth/v1/user`,{method:'PUT',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({password})});
  }catch(e){return 'Erro de ligação — tenta outra vez.';}
  if(r.ok)return '';
  let d={};try{d=await r.json();}catch(_){}
  const msg=d.error_description||d.msg||d.message||('HTTP '+r.status);
  if(/should be different/i.test(msg))return 'Essa já é a password atual — escolhe outra.';
  if(r.status===401||r.status===403)return 'A sessão do link já expirou. Pede outro email de recuperação.';
  return msg;
}
async function sbDefinirNovaPassword(){
  const p1=document.getElementById('nova-pass-1').value;
  const p2=document.getElementById('nova-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){sbAuthStatus('nova-pass-status',erro,'var(--dg)');return;}
  const btn=document.getElementById('btn-nova-pass');
  btn.disabled=true;btn.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){sbAuthStatus('nova-pass-status',falha,'var(--dg)');btn.disabled=false;btn.textContent='Guardar password';return;}
  document.getElementById('nova-pass-campos').style.display='none';
  document.getElementById('btn-nova-pass-entrar').style.display='';
  sbAuthStatus('nova-pass-status','Password alterada ✓','var(--vd)');
}
function toggleAdmPass(){
  const b=document.getElementById('adm-pass-box');
  b.style.display=b.style.display==='none'?'':'none';
  document.getElementById('adm-pass-status').textContent='';
}
async function sbAlterarPassword(){
  const st=document.getElementById('adm-pass-status');
  const p1=document.getElementById('adm-pass-1').value;
  const p2=document.getElementById('adm-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){st.style.color='var(--dg)';st.textContent=erro;return;}
  st.style.color='var(--mu)';st.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){st.style.color='var(--dg)';st.textContent=falha;return;}
  document.getElementById('adm-pass-1').value='';document.getElementById('adm-pass-2').value='';
  st.style.color='var(--vd)';st.textContent='Password alterada ✓';
}
async function sbSolicitarAcesso(){
  if(!_sbSession)return;
  const btn=document.getElementById('btn-solicitar');
  const btnV=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A enviar…';
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/access_requests`,{method:'POST',
      headers:sbHeaders({'Prefer':'return=minimal'}),body:JSON.stringify({email:_sbSession.user.email})});
    if(r.ok||r.status===409){
      status.style.display='block';status.style.color='var(--vd)';
      status.textContent=r.status===409?'✓ O pedido já estava registado. Aguarda aprovação.':'✓ Pedido enviado! Aguarda aprovação.';
      btn.style.display='none';btnV.style.display='';return;
    }
    let msg='HTTP '+r.status;try{const j=await r.json();msg=j.message||msg;}catch(_){}
    if(r.status===401)msg='Sessão expirada — sai e volta a entrar.';
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro ao enviar pedido: '+msg;
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }catch(e){
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro de ligação — tenta novamente.';
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }
}
async function sbVerificarAcesso(){
  const btn=document.getElementById('btn-verificar');
  btn.disabled=true;btn.textContent='A verificar…';
  await sbAposLogin();
  btn.disabled=false;btn.textContent='🔄 Verificar acesso';
  const s=document.getElementById('solicitar-status');
  if(document.getElementById('page-sem-acesso').style.display!=='none'){
    s.style.display='block';s.style.color='var(--mu)';s.textContent='Ainda não aprovado. Tenta mais tarde.';
  }
}
function sbLogout(){
  localStorage.removeItem(SESSION_KEY);_sbSession=null;window.location.reload();
}

/* ── DEFINIÇÕES ────────────────────────────────────────────────────── */
function renderCfg(){
  const el=document.getElementById('conta-email');
  if(el)el.textContent=_sbSession?`Sessão iniciada como ${_sbSession.user.email}`:'';
  const papel=document.getElementById('conta-papel');
  if(papel)papel.textContent=isAdmin()
    ?'És o admin desta garrafeira — mandas em quem tem acesso e em quem pode editar.'
    :(podeEditar()?'Podes acrescentar, mover e dar saída a garrafas.':'Podes ver e procurar, mas não editar.');
  const sobre=document.getElementById('sobre-box');
  if(sobre)sobre.innerHTML=`${db.vinhos.length} vinhos · ${db.garrafas.length} garrafas (${db.garrafas.filter(naGarrafeira).length} na garrafeira) · ${db.castas.length} castas · ${db.locais.length} locais.<br>
    Dados e login no Supabase, schema <code>garrafeira</code>. Admin atual: <b>${esc(ADMIN_EMAIL)}</b>.`;
  renderCfgLocais();
  if(isAdmin()){admRenderPedidos();admRenderUtilizadores();}
}

/* ── LOCAIS (config) ───────────────────────────────────────────────── */
function renderCfgLocais(){
  const box=document.getElementById('cfg-locais');
  if(!box)return;
  if(!db.locais.length){box.innerHTML='<div class="note" style="padding:8px 0">Ainda não há locais. Cria o primeiro.</div>';return;}
  box.innerHTML=db.locais.map(l=>{
    const n=db.garrafas.filter(g=>g.local_id===l.id&&naGarrafeira(g)).length;
    return `<div class="ua-row">
      <span class="pip" style="width:11px;height:11px;border-radius:50%;background:${esc(l.cor||'#7b1f3d')};flex-shrink:0"></span>
      <span class="em"><b>${esc(l.nome)}</b>${l.descricao?' — '+esc(l.descricao):''}</span>
      <span class="tagme">${n}</span>
      <button class="jdel" style="color:var(--mu)" title="Editar" onclick="editarLocal(${l.id})">✏️</button>
      <button class="jdel" title="Apagar" onclick="apagarLocal(${l.id})">✕</button>
    </div>`;
  }).join('');
}
function novoLocal(){
  if(roGuard())return;
  abrirLocalModal(null);
}
function editarLocal(id){
  if(roGuard())return;
  const l=IDXL[id];if(!l)return;
  abrirLocalModal(l);
}
function abrirLocalModal(l){
  document.getElementById('modal-local-in').innerHTML=`
    <div class="mtop"><h3>${l?'Editar local':'Novo local'}</h3>
      <button class="mx" onclick="fecharModal('modal-local')">✕</button></div>
    <label>Nome</label>
    <input type="text" id="loc-nome" value="${esc(l?l.nome:'')}" placeholder="Frigorífico da cozinha">
    <label>Descrição (opcional)</label>
    <input type="text" id="loc-desc" value="${esc(l?l.descricao:'')}" placeholder="Níveis 1 a 14">
    <div class="macoes">
      <button class="btn prim" id="loc-btn" onclick="guardarLocalModal(${l?l.id:0})">Guardar</button>
      <button class="btn ghost" onclick="fecharModal('modal-local')">Cancelar</button>
    </div>`;
  abrirModal('modal-local');
}
async function guardarLocalModal(id){
  const nome=document.getElementById('loc-nome').value.trim();
  if(!nome){toast('O nome é obrigatório',1);return;}
  const dados={nome,descricao:document.getElementById('loc-desc').value.trim()};
  const btn=document.getElementById('loc-btn');
  btn.disabled=true;btn.textContent='A guardar…';
  try{
    if(id){
      await sbReq('PATCH',`locais?id=eq.${id}`,dados);
      Object.assign(IDXL[id],dados);
    }else{
      const r=await sbReq('POST','locais',[Object.assign({ordem:db.locais.length+1},dados)],{'Prefer':'return=representation'});
      db.locais.push(r[0]);reindexar();
    }
    fecharModal('modal-local');
    renderCfgLocais();renderLista();
    if(tabAtiva==='locais')renderMapa();
    toast(id?'Guardado ✓':'Local criado ✓');
  }catch(e){
    toast(/duplicate|unique/i.test(e.message)?'Já existe um local com esse nome':'Não foi possível: '+e.message,1);
    btn.disabled=false;btn.textContent='Guardar';
  }
}
async function apagarLocal(id){
  if(roGuard())return;
  const l=IDXL[id];if(!l)return;
  const n=db.garrafas.filter(g=>g.local_id===id).length;
  // As garrafas NÃO se perdem (a FK é ON DELETE SET NULL) — passam a
  // aparecer no mapa em "Por arrumar". Dizê-lo aqui evita o susto.
  if(!confirm(`Apagar o local "${l.nome}"?`+(n?`\n\nAs ${n} garrafas que lá estão não se perdem: ficam em "Por arrumar" no mapa, à espera de um local novo.`:'')))return;
  try{
    await sbReq('DELETE',`locais?id=eq.${id}`);
    db.locais=db.locais.filter(x=>x.id!==id);
    db.garrafas.forEach(g=>{if(g.local_id===id)g.local_id=null;});
    reindexar();renderCfgLocais();renderLista();
    if(tabAtiva==='locais')renderMapa();
    toast('Local apagado');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}

/* ── UTILIZADORES (admin) ──────────────────────────────────────────── */
async function admRenderPedidos(){
  const box=document.getElementById('adm-pedidos-list');
  if(!box)return;
  try{
    const reqs=await sbReq('GET','access_requests?select=email,requested_at&order=requested_at.asc');
    if(!reqs||!reqs.length){box.innerHTML='<div class="note" style="padding:6px 0">Sem pedidos pendentes.</div>';return;}
    box.innerHTML=reqs.map(r=>`<div class="ua-row">
      <span class="em">${esc(r.email)}</span>
      <button class="jdel" style="color:var(--vd)" title="Aprovar" onclick="admAprovar('${escJs(r.email)}')">✓</button>
      <button class="jdel" title="Recusar" onclick="admRecusar('${escJs(r.email)}')">✕</button>
    </div>`).join('');
  }catch(e){box.innerHTML=`<div class="note">Não foi possível ler os pedidos: ${esc(e.message)}</div>`;}
}
async function admAprovar(email){
  try{
    await sbReq('POST','allowed_users',[{email}],{'Prefer':'return=minimal,resolution=ignore-duplicates'});
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    admRenderPedidos();admRenderUtilizadores();
    toast('Acesso dado a '+email);
  }catch(e){toast('Não foi possível: '+e.message,1);}
}
async function admRecusar(email){
  if(!confirm('Recusar o pedido de '+email+'?'))return;
  try{
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    admRenderPedidos();
  }catch(e){toast('Não foi possível: '+e.message,1);}
}
let _admUsers=[];
async function admRenderUtilizadores(){
  const box=document.getElementById('adm-users-list');
  if(!box)return;
  try{
    _admUsers=await sbReq('GET','allowed_users?select=email,nome,pode_editar&order=email.asc')||[];
  }catch(e){box.innerHTML=`<div class="note">${esc(e.message)}</div>`;return;}
  box.innerHTML=_admUsers.map(u=>{
    const eAdmin=u.email.toLowerCase()===String(ADMIN_EMAIL).toLowerCase();
    return `<div class="ua-row">
      <span class="em">${esc(u.email)}${u.nome?' ('+esc(u.nome)+')':''}</span>
      ${eAdmin?'<span class="tagme">admin</span>'
        :`<label class="chk"><input type="checkbox"${u.pode_editar?' checked':''}
            onchange="admToggleEditor('${escJs(u.email)}',this.checked)"> editor</label>
          <button class="jdel" title="Tirar acesso" onclick="admTirarAcesso('${escJs(u.email)}')">✕</button>`}
    </div>`;
  }).join('')||'<div class="note" style="padding:6px 0">Ninguém na lista.</div>';

  // Os dois selects (password temporária e passar a app) saem da MESMA
  // lista — nunca podem oferecer alguém que não tenha acesso.
  const outros=_admUsers.filter(u=>u.email.toLowerCase()!==String(ADMIN_EMAIL).toLowerCase());
  const op=l=>l.map(u=>`<option value="${esc(u.email)}">${esc(u.email)}</option>`).join('');
  const s1=document.getElementById('adm-pt-email');
  const s2=document.getElementById('adm-dono-email');
  if(s1)s1.innerHTML=outros.length?op(outros):'<option value="">(mais ninguém tem acesso)</option>';
  if(s2)s2.innerHTML=outros.length?op(outros):'<option value="">(mais ninguém tem acesso)</option>';
}
async function admToggleEditor(email,val){
  try{
    await sbReq('PATCH',`allowed_users?email=eq.${encodeURIComponent(email)}`,{pode_editar:val});
    toast(val?email+' passa a poder editar':email+' fica só a ver');
  }catch(e){toast('Não foi possível: '+e.message,1);admRenderUtilizadores();}
}
async function admTirarAcesso(email){
  if(!confirm('Tirar o acesso a '+email+'?'))return;
  try{
    await sbReq('DELETE',`allowed_users?email=eq.${encodeURIComponent(email)}`);
    admRenderUtilizadores();toast('Acesso retirado');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}
async function admAdicionarUtilizador(){
  const inp=document.getElementById('adm-user-novo');
  const email=inp.value.trim().toLowerCase();
  if(!email||!email.includes('@')){toast('Email inválido',1);return;}
  try{
    await sbReq('POST','allowed_users',[{email}],{'Prefer':'return=minimal,resolution=ignore-duplicates'});
    inp.value='';admRenderUtilizadores();
    toast('Acesso dado ✓ — ele já pode entrar com essa conta');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}
async function admGerarPassTemp(){
  const st=document.getElementById('adm-pt-status');
  const email=document.getElementById('adm-pt-email').value;
  const pass=document.getElementById('adm-pt-pass').value.trim();
  if(!email){st.style.color='var(--dg)';st.textContent='Escolhe a conta.';return;}
  if(pass.length<8){st.style.color='var(--dg)';st.textContent='A password tem de ter pelo menos 8 caracteres.';return;}
  st.style.color='var(--mu)';st.textContent='A gerar…';
  try{
    await sbRpc('admin_pass_temp',{p_email:email,p_pass:pass});
    st.style.color='var(--vd)';
    st.textContent=`✓ Feito. Diz-lhe a password por telefone e pede-lhe para a trocar em Definições › Conta.`;
    document.getElementById('adm-pt-pass').value='';
  }catch(e){
    st.style.color='var(--dg)';
    st.textContent=/function|does not exist|404/i.test(e.message)
      ?'Falta correr o db/functions.sql no Supabase (a função admin_pass_temp).'
      :e.message;
  }
}
async function admPassarAdmin(){
  const st=document.getElementById('adm-dono-status');
  const email=document.getElementById('adm-dono-email').value;
  if(!email){st.style.color='var(--dg)';st.textContent='Escolhe a pessoa.';return;}
  if(!confirm(`Passar a app a ${email}?\n\nA partir daí é ELE que manda em quem tem acesso — tu ficas como editor. Só ele te pode devolver o lugar.`))return;
  st.style.color='var(--mu)';st.textContent='A passar…';
  try{
    await sbRpc('definir_admin',{p_email:email});
    st.style.color='var(--vd)';st.textContent='✓ Feito. A recarregar…';
    setTimeout(()=>window.location.reload(),1200);
  }catch(e){st.style.color='var(--dg)';st.textContent=e.message;}
}

/* ── EXPORTAR ──────────────────────────────────────────────────────── */
/* ── EXPORTAR A LISTA PARA PDF ─────────────────────────────────────
   Sem biblioteca nenhuma: monta-se uma tabela num `#print-area` que só
   existe para a impressão e chama-se `window.print()` — quem imprime
   escolhe "Guardar como PDF" (no iOS é o próprio menu de partilha). Uma
   biblioteca de PDF eram centenas de KB num sítio onde não há build, e o
   resultado seria pior do que o que o browser já sabe fazer.

   A folha vai na HORIZONTAL (`@page landscape`) porque são doze colunas —
   em retrato os nomes dos vinhos partiam-se todos. Os grupos são os mesmos
   que estão no ecrã (região ou ano), para o papel bater certo com a app. */
function exportarPDF(){
  const res=db.vinhos.filter(v=>stockDe(v.id)>0);
  if(!res.length){toast('Não há vinhos para exportar',1);return;}
  const nGar=res.reduce((s,v)=>s+stockDe(v.id),0);
  const grupos=agruparVinhos(res,DET_AGRUPAR);

  const onde=v=>garrafasDe(v.id,true).map(g=>{
    const p=[nomeLocal(g.local_id)];
    if(g.prateleira)p.push(g.prateleira);
    if(g.lugar)p.push('lugar '+g.lugar);
    return p.join(' · ');
  }).join('; ');
  const janela=v=>{
    if(!v.beber_de&&!v.beber_ate)return '';
    return `${v.beber_de||'?'}–${v.beber_ate||'?'}`;
  };

  const cols=['Vinho','Ano','Produtor','Tipo','Região','Castas','Menção / Class.',
              '% Álc.','Preço méd.','Beber','Onde está','Gar.'];
  const linhas=grupos.map(g=>`
    <tr class="pgrupo"><td colspan="${cols.length}">${esc(g.titulo)} — ${g.vinhos.length} vinho${g.vinhos.length===1?'':'s'}</td></tr>
    ${g.vinhos.map(v=>`<tr>
      <td class="pnome">${esc(v.nome)}</td>
      <td class="pc">${v.ano||''}</td>
      <td>${esc(v.produtor)}</td>
      <td>${esc([v.tipo,v.estilo].filter(Boolean).join(' · '))}</td>
      <td>${esc([v.regiao,v.sub_regiao].filter(Boolean).join(' · '))}</td>
      <td>${esc((v.castas||[]).join(', '))}</td>
      <td>${esc([v.mencao,v.classificacao].filter(Boolean).join(' · '))}</td>
      <td class="pc">${v.teor!=null&&v.teor!==''?esc(v.teor):''}</td>
      <td class="pc">${v.preco_medio!=null?eur(v.preco_medio):''}</td>
      <td class="pc">${janela(v)}</td>
      <td>${esc(onde(v))}</td>
      <td class="pc">${stockDe(v.id)}</td>
    </tr>`).join('')}`).join('');

  let box=document.getElementById('print-area');
  if(!box){box=document.createElement('div');box.id='print-area';document.body.appendChild(box);}
  box.innerHTML=`
    <div class="pcab">
      <div><h1>Garrafeira</h1>
        <div class="psub">${res.length} vinho${res.length===1?'':'s'} · ${nGar} garrafa${nGar===1?'':'s'} ·
          por ${DET_AGRUPAR==='ano'?'ano':DET_AGRUPAR==='casta'?'casta':'região'}</div></div>
      <div class="pdata">${dataPT(hoje())}</div>
    </div>
    <table>
      <thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${linhas}</tbody>
    </table>`;
  // Chamar print() logo a seguir ao innerHTML apanha o Safari a meio do
  // layout da tabela nova: a pré-visualização aparece e fecha-se sozinha,
  // e a tentativa seguinte vem bloqueada ("impedido de imprimir
  // automaticamente"). Dois requestAnimationFrame dão tempo à página para
  // desenhar a tabela antes do print(), sem sair do gesto do utilizador.
  requestAnimationFrame(()=>requestAnimationFrame(()=>window.print()));
}
// A tabela só serve a impressão — depois de imprimir não vale a pena
// continuar a segurar umas centenas de linhas no DOM.
window.addEventListener('afterprint',()=>{
  const box=document.getElementById('print-area');
  if(box)box.innerHTML='';
});

function exportarJSON(){
  const dados={
    exportadoEm:new Date().toISOString(),
    locais:db.locais,
    vinhos:db.vinhos.map(v=>Object.assign({},v,{garrafas:garrafasDe(v.id,false)})),
    castas:db.castas.map(c=>c.nome)
  };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(dados,null,2)],{type:'application/json'}));
  a.download=`garrafeira-${hoje()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast('Exportado ✓');
}

/* ── DIAGNÓSTICO ───────────────────────────────────────────────────── */
async function renderDiag(){
  const box=document.getElementById('diag-box');
  box.innerHTML='<div class="note">A ler…</div>';
  try{
    const l=await sbReq('GET','sync_log?select=*&order=criado_em.desc&limit=25');
    if(!l||!l.length){box.innerHTML='<div class="note">Sem registos ainda.</div>';return;}
    box.innerHTML=l.map(r=>`<div class="diag-l">
      <b>${esc(r.estado)}</b> · ${esc(String(r.criado_em).slice(0,19).replace('T',' '))} · ${esc(r.origem)}
      ${r.quem?' · '+esc(r.quem):''}<br>${esc(JSON.stringify(r.detalhe||{}).slice(0,300))}</div>`).join('');
  }catch(e){
    box.innerHTML=`<div class="note">${/relation|does not exist/i.test(e.message)
      ?'A tabela sync_log ainda não existe (corre o db/schema.sql).':esc(e.message)}</div>`;
  }
}

/* ── INIT ──────────────────────────────────────────────────────────── */
async function sbInit(){
  try{
    if(await sbTratarHashAuth())return;
  }catch(e){
    if(window.location.hash.length>1||window.location.search.length>1){
      sbLimparHash();sbMostrarLogin();
      sbAuthStatus('login-status','Não foi possível validar o link — sem ligação. Tenta outra vez.','var(--dg)');
      return;
    }
  }
  const stored=localStorage.getItem(SESSION_KEY);
  if(stored){
    try{
      _sbSession=JSON.parse(stored);
      if(tokenQuaseExpirado())await sbRefresh();
      let r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      if(!r.ok&&_sbSession.refresh_token){
        if(await sbRefresh())
          r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      }
      if(r.ok){sbSaveSession(Object.assign({},_sbSession,{user:await r.json()}));await sbAposLogin();return;}
    }catch(e){}
    _sbSession=null;localStorage.removeItem(SESSION_KEY);
  }
  sbMostrarLogin();
}

// A altura do cabeçalho decide onde os separadores colam. Fixá-la em CSS
// dava um buraco (ou uma sobreposição) assim que o subtítulo mudava de
// tamanho — por isso mede-se.
function ajustarSticky(){
  const h=document.querySelector('body>header');
  if(h)document.querySelector('.itabs').style.top=h.offsetHeight+'px';
}
window.addEventListener('resize',ajustarSticky);

// Enter no campo de procura fecha o teclado do telemóvel (em vez de
// submeter coisa nenhuma, que era o que o browser tentava fazer).
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.id==='f-texto'){e.preventDefault();e.target.blur();}
  if(e.key==='Escape')document.querySelectorAll('.modal.on').forEach(m=>fecharModal(m.id));
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
// Começa fechado e só abre quando `carregar()` souber quem é quem. Ao
// contrário, havia um instante — entre o HTML aparecer e as permissões
// chegarem — em que quem só pode VER tinha o botão de apagar à frente.
document.body.classList.add('readonly','naoadmin','naodono');
ajustarSticky();
pgSwipe();
sbInit();
