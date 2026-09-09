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

/* ── A GARRAFEIRA ABERTA ───────────────────────────────────────────────
   A app é a mesma para toda a gente, as tabelas são as mesmas — o que muda
   é a GARRAFEIRA que está aberta. Cada pessoa tem a sua (`garrafeiras.dono`)
   e só vê as garrafas dela; emprestar a um amigo é uma linha em `partilhas`,
   e uma garrafeira emprestada é SEMPRE só de leitura.

   `GA_ID` é a que está aberta neste momento. Fica no localStorage para
   voltar à mesma no arranque seguinte — mas nunca é a última palavra: no
   `carregar()` só vale se ainda constar da lista que a BD devolveu. Se
   deixaram de me emprestar aquela garrafeira, o id guardado aqui não pode
   ser o que decide o que se pede ao servidor. */
const GA_KEY='garrafeira_ativa';
let GA_LISTA=[], GA_ID=null;

function emailSessao(){return String((_sbSession&&_sbSession.user&&_sbSession.user.email)||'').toLowerCase();}
function garrafeiraAtiva(){return GA_LISTA.find(g=>g.id===GA_ID)||null;}
function souDonoDaGarrafeira(g){
  g=g||garrafeiraAtiva();
  return !!(g&&String(g.dono||'').toLowerCase()===emailSessao());
}
function minhasGarrafeiras(){return GA_LISTA.filter(g=>souDonoDaGarrafeira(g));}
function nomeGarrafeira(){const g=garrafeiraAtiva();return g?g.nome:'';}
/* O que o DONO desta garrafeira deu ao admin da app. Numa que seja do
   próprio admin não quer dizer nada (ele já lá entra por ser dono) — a
   função SQL com o mesmo nome faz exatamente a mesma ressalva. */
function acessoAdmin(g){
  g=g||garrafeiraAtiva();
  if(!g||!isAdmin()||souDonoDaGarrafeira(g))return 'nenhuma';
  return String(g.admin_acesso||'nenhuma');
}
// Estou aqui a mando do dono, e não por ser meu?
function souAdminConvidado(g){return acessoAdmin(g)!=='nenhuma';}
// De quem é a que está aberta, para as frases da UI. É o EMAIL e não um
// nome bonito de propósito: `allowed_users.nome` só o admin o consegue ler
// (a policy `au_sel` deixa ver a própria linha), por isso um nome aqui
// aparecia a uns e não a outros — e um email é o que identifica a pessoa
// sem ambiguidade nenhuma quando se está prestes a partilhar com ela.
function donoGarrafeira(){
  const g=garrafeiraAtiva();
  return g?String(g.dono||''):'';
}

/* ── PERMISSÕES ────────────────────────────────────────────────────────
   Três níveis, iguais aos de db/policies.sql, MAIS a garrafeira aberta:
     · quem tem acesso  entra na app
     · editor           mexe em vinhos/garrafas/locais
     · admin            manda em quem tem acesso e em quem é editor
     · e o dono         é o único que escreve NA SUA garrafeira
   `isReadOnly` é "não posso editar isto que está aberto" — e passou a ter
   duas causas: ou não sou editor, ou a garrafeira aberta é de outra pessoa.
   Numa garrafeira emprestada não há meio-termo nenhum: vê-se, não se mexe. */
let isReadOnly=true, EU={email:'',pode_editar:false,ia_plano:'sem_ia'};
function isAdmin(){
  return !!(_sbSession&&_sbSession.user&&
    String(_sbSession.user.email||'').toLowerCase()===String(ADMIN_EMAIL||'').toLowerCase());
}
// "Posso editar em geral" (o `pode_editar` de allowed_users) — é diferente
// de poder editar o que está AGORA no ecrã, que é o `podeEditar()`.
function souEditor(){return isAdmin()||!!EU.pode_editar;}
// A UI só explica o plano; a Edge Function volta a confirmá-lo através da
// base de dados antes de tocar em qualquer chave Gemini.
function planoIA(){return isAdmin()?'premium':String(EU.ia_plano||'sem_ia');}
function podeUsarIA(){return planoIA()==='gratis'||planoIA()==='premium';}
// `planoIA()` é o DIREITO da pessoa; o MOTOR de cada procura é outra coisa.
// Cada um procura com o motor a que tem direito, e quem é premium pode pedir
// uma segunda opinião ao outro para os comparar (ver a secção da IA).
function temPremium(){return planoIA()==='premium';}
function motorDoPlano(){return temPremium()?'premium':'gratis';}
function rotuloMotor(m){return m==='premium'?'IA com pesquisa web (Grounding Search)':'IA sem pesquisa web';}
// Duas portas, e só duas: a minha garrafeira, ou uma em que o dono deu
// 'edicao' ao admin. Uma partilha nunca abre esta — é sempre só de ver.
function podeEditar(){
  if(souDonoDaGarrafeira())return souEditor();
  return acessoAdmin()==='edicao';
}
function aplicarPermissoes(){
  isReadOnly=!podeEditar();
  document.body.classList.toggle('readonly',isReadOnly);
  document.body.classList.toggle('naoadmin',!isAdmin());
  document.body.classList.toggle('naodono',!souDono());
  // `naominha` é "não sou o DONO", e não "não posso editar": o admin com
  // 'edicao' mexe nas garrafas mas continua sem poder partilhar, renomear
  // ou passar a garrafeira de outra pessoa — mexe no que lhe abriram, não
  // na fechadura.
  document.body.classList.toggle('naominha',!souDonoDaGarrafeira());
  aplicarCabecalho();
}

/* O nome da garrafeira aberta, por baixo do título. É a única coisa no ecrã
   que diz DE QUEM é o que se está a ver — sem isto, uma garrafeira
   emprestada só se distinguia da própria por os botões terem desaparecido,
   que é uma app avariada e não uma app clara. Só aparece quando não é a
   única: com uma garrafeira só, repetir "Garrafeira do Barrona" por baixo
   de "Garrafeira" não acrescenta nada.
   A altura do cabeçalho muda com ele, por isso remede-se o sticky. */
function aplicarCabecalho(){
  const el=document.getElementById('hdr-garrafeira');
  if(!el)return;
  const g=garrafeiraAtiva();
  const mostrar=!!g&&(GA_LISTA.length>1||!souDonoDaGarrafeira(g));
  el.textContent=mostrar?(souDonoDaGarrafeira(g)?g.nome:`${g.nome} · de ${g.dono}`
    +(acessoAdmin(g)==='edicao'?' · podes editar':'')):'';
  el.style.display=mostrar?'':'none';
  ajustarSticky();
}
// Guarda de UI. Devolve true quando a ação deve parar aqui. As duas razões
// para dizer que não são diferentes e merecem frases diferentes — "não
// tens permissão" numa garrafeira que é de outra pessoa manda procurar um
// botão que não existe.
function roGuard(){
  if(!isReadOnly)return false;
  if(!garrafeiraAtiva())toast('Ainda não tens garrafeira — vê em Definições › Garrafeiras',1);
  else if(!souDonoDaGarrafeira())toast(`👀 ${nomeGarrafeira()} é de ${donoGarrafeira()} — aqui só podes ver`,1);
  else toast('🔒 Não tens permissão para editar a garrafeira',1);
  // (o admin com 'edicao' nunca chega aqui — `podeEditar()` já disse que sim)
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

/* Duas voltas ao servidor, e não uma: primeiro quem sou eu e que
   garrafeiras posso ver, só depois o que está DENTRO da que ficou aberta.
   Não dá para pedir tudo de uma vez porque o pedido dos vinhos leva o
   `garrafeira_id` no filtro — e esse só se sabe depois de a lista chegar.
   (A RLS filtrava na mesma sem o filtro; mas então quem tem duas
   garrafeiras, ou uma emprestada, recebia as duas misturadas no mesmo
   ecrã.) */
async function carregar(){
  const [castas,cfg,eu,gars]=await Promise.all([
    sbReq('GET','castas?select=*&order=nome.asc'),
    sbReq('GET','config?select=*'),
    sbReq('GET',`allowed_users?select=email,nome,pode_editar,ia_plano&email=eq.${encodeURIComponent(_sbSession.user.email)}`),
    sbReq('GET','garrafeiras?select=*&order=nome.asc')
  ]);
  db.castas=castas||[];
  db.config={};(cfg||[]).forEach(c=>db.config[c.chave]=c.valor);
  if(db.config.admin_email)ADMIN_EMAIL=db.config.admin_email;

  // O admin pode não estar na sua própria lista (is_allowed() dá-lhe acesso
  // à mesma) — nesse caso não vem linha nenhuma e ele fica editor por ser
  // admin, que é o que a BD também decide.
  const minha=(eu||[])[0]||null;
  EU={email:_sbSession.user.email,pode_editar:minha?!!minha.pode_editar:false,nome:minha?minha.nome:'',ia_plano:minha?minha.ia_plano||'sem_ia':'sem_ia'};

  GA_LISTA=gars||[];
  // Quem pode editar e ainda não tem garrafeira nenhuma ganha a dele aqui —
  // a app não tem (nem quer ter) um ecrã de "cria primeiro a tua
  // garrafeira": entra-se e ela está lá, vazia. A função é idempotente e
  // resolve dois separadores abertos ao mesmo tempo.
  let acabadaDeNascer=false;
  if(souEditor()&&!minhasGarrafeiras().length){
    try{
      await sbRpc('garantir_garrafeira',{p_nome:EU.nome?`Garrafeira de ${EU.nome}`:null});
      GA_LISTA=await sbReq('GET','garrafeiras?select=*&order=nome.asc')||[];
      acabadaDeNascer=minhasGarrafeiras().length>0;
    }catch(e){/* sem garrafeira própria vê-se o que estiver partilhado */}
  }
  GA_ID=escolherGarrafeira(acabadaDeNascer);
  if(GA_ID)localStorage.setItem(GA_KEY,String(GA_ID));
  await carregarGarrafeira();
}

/* Qual fica aberta. Por ordem: a que estava da última vez (se ainda cá
   estiver — pode ter deixado de ser partilhada), depois a MINHA, e só no
   fim a primeira da lista. A minha à frente de uma emprestada de
   propósito: entrar na app e cair na garrafeira de outra pessoa, em modo
   de leitura, é uma app que parece avariada.

   `acabadaDeNascer` é a exceção, e ganha à regra de cima: uma garrafeira
   criada HÁ UM SEGUNDO está forçosamente vazia, e abrir a app num ecrã
   vazio quando há garrafas para mostrar lê-se como "perdi tudo". Foi o que
   ia acontecer ao Barrona na primeira entrada depois desta mudança — a
   garrafeira dele ainda na conta de quem montou a app, e a dele própria
   acabada de nascer sem nada lá dentro. Assim ele cai onde estão as
   garrafas, e a vazia fica no seletor à espera. */
function escolherGarrafeira(acabadaDeNascer){
  if(!GA_LISTA.length)return null;
  const guardada=parseInt(localStorage.getItem(GA_KEY)||'',10);
  if(guardada&&GA_LISTA.some(g=>g.id===guardada))return guardada;
  const minhas=minhasGarrafeiras();
  if(acabadaDeNascer&&GA_LISTA.length>minhas.length)
    return GA_LISTA.find(g=>!souDonoDaGarrafeira(g)).id;
  return (minhas[0]||GA_LISTA[0]).id;
}

/* O conteúdo da garrafeira aberta. Sai daqui separado do `carregar()`
   porque é exatamente isto — e só isto — que se refaz ao trocar de
   garrafeira: a lista de garrafeiras, quem sou eu e as castas não mudaram. */
async function carregarGarrafeira(){
  if(!GA_ID){
    db.locais=[];db.vinhos=[];db.garrafas=[];
    IMG_ASSINADA={};reindexar();aplicarPermissoes();return;
  }
  const f=`garrafeira_id=eq.${GA_ID}`;
  const [locais,vinhos,garrafas,vc]=await Promise.all([
    sbReq('GET',`locais?${f}&select=*&order=ordem.asc,nome.asc`),
    sbReq('GET',`vinhos?${f}&select=*&order=nome.asc`),
    sbReq('GET',`garrafas?${f}&select=*&order=id.asc`),
    // `vinho_castas` não tem `garrafeira_id` (a garrafeira dela é a do
    // vinho): a RLS já não deixa sair as linhas dos vinhos que não posso
    // ver, e as que sobram de outra garrafeira minha só ficam sem par no
    // `porVinho` — ninguém as procura.
    sbReq('GET','vinho_castas?select=*')
  ]);
  db.locais=locais||[];db.vinhos=vinhos||[];db.garrafas=garrafas||[];

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
  await detetarLayoutLocais();
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
// `locais.layout` é coluna NOVA (ver db/schema.sql) — mesmo padrão:
// enquanto não existir, o desenho das prateleiras fica desligado e os locais
// continuam a comportar-se como hoje.
let TEM_LOCAL_LAYOUT=false;
async function detetarLayoutLocais(){
  if(db.locais.length){TEM_LOCAL_LAYOUT=('layout' in db.locais[0]);return;}
  try{await sbReq('GET','locais?select=layout&limit=1');TEM_LOCAL_LAYOUT=true;}
  catch(e){TEM_LOCAL_LAYOUT=false;}
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

/* Um `imagem_url` preenchido não é o mesmo que uma imagem que abre — a IA
   às vezes traz um link de uma loja que entretanto mudou a foto ou tirou o
   produto do ar. `IMG_QUEBRADA` guarda, por vinho, QUAL foi o URL testado
   e falhou; comparar o URL (não só um booleano) é o que faz um link novo
   (ex.: repetir a procura da IA) voltar a ser testado em vez de ficar
   marcado como partido para sempre. `verificarImagens()` testa em segundo
   plano com um `Image()` fora do DOM — o mesmo teste que o `onerror` do
   `<img>` já faz ao mostrar a garrafa, só que aqui o resultado alimenta o
   "A completar" em vez de só esconder o quadrado vazio. */
let IMG_QUEBRADA={};        // vinho_id -> URL testado que não carregou
function imagemFuncional(v){
  const img=imagemDe(v);
  return !!img&&IMG_QUEBRADA[v.id]!==img;
}
function verificarImagens(){
  db.vinhos.forEach(v=>{
    const url=imagemDe(v);
    if(!url||IMG_QUEBRADA[v.id]===url)return;
    const img=new Image();
    img.onerror=()=>{
      if(IMG_QUEBRADA[v.id]===url)return;
      IMG_QUEBRADA[v.id]=url;
      renderResumo();
    };
    img.src=url;
  });
}

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
function prateleirasDesc(lista){
  return [...(lista||[])].sort((a,b)=>ordPrateleira(String((b&&b.nome)||b||''),String((a&&a.nome)||a||'')));
}
/* Dois formatos, e só dois: uma fila de lugares, ou duas filas sobrepostas
   (garrafas em profundidade). O ziguezague foi-se — ver `layoutLocal`. */
const FORMATOS_PRATELEIRA=[['fila','Fila'],['sobrepostos','Sobrepostos']];
const FORMATO_PRAT_LABEL=Object.fromEntries(FORMATOS_PRATELEIRA);
// Onde fica o lugar a mais numa prateleira de sobrepostos com capacidade
// ímpar. Era usado também pelo ziguezague, que já não existe.
const MAIS_EM=[['cima','Em cima'],['baixo','Em baixo']];
function normalizarFormatoPrateleira(v){
  return chave(v).replace(/\s+/g,'')==='sobrepostos'?'sobrepostos':'fila';
}
function formatoPrateleiraNome(v){return FORMATO_PRAT_LABEL[normalizarFormatoPrateleira(v)]||'Fila';}
function normalizarSobrepostosMaisEm(v){
  return chave(v)==='baixo'?'baixo':'cima';
}
/* Onde fica cada lugar: coluna e fila na grelha, por formato.
   - fila: um por coluna;
   - sobrepostos: enche a fila de cima e a de baixo aos pares (1 em cima, 2
     em baixo, 3 em cima…), e com capacidade ímpar `mais_em` diz onde fica o
     lugar a mais. A grelha dos sobrepostos é em MEIAS-colunas (`span:2`):
     é o que deixa a fila mais curta começar meia coluna à frente e ficar
     CENTRADA em vez de encostada à esquerda.
   O NÚMERO de cada lugar sai do `base` da prateleira (ver `layoutLocal`):
   a numeração é corrida no local, não recomeça em cada nível.
   `cols` são as colunas a sério (para larguras); `gridCols` as unidades da
   grelha (iguais, ou o dobro nos sobrepostos). */
function prateleiraLayoutInfo(p,opt){
  const preview=!!(opt&&opt.preview);
  const formato=normalizarFormatoPrateleira(p&&p.formato);
  const mais_em=normalizarSobrepostosMaisEm(p&&p.mais_em);
  const capMax=preview?7:240;
  const capacidade=Math.max(1,Math.min(capMax,inteiro((p&&p.capacidade))||0));
  const base=preview?0:Math.max(0,inteiro(p&&p.base)||0);
  const cols=formato==='sobrepostos'?Math.max(Math.ceil(capacidade/2),Math.floor(capacidade/2)):capacidade;
  /* A grelha é sempre a do MÓVEL (`colsw` colunas), em MEIAS-colunas e em
     frações: a prateleira ocupa a largura toda e os lugares ficam
     centrados nela, deslocando-se meia coluna quando têm de desencontrar.
     Com colunas de largura fixa isto transbordava assim que o móvel era
     mais largo do que o espaço, e os lugares encostavam à esquerda em vez
     de ficarem centrados — o desenho deixava de bater com a madeira. */
  const colsw=preview?cols:Math.max(cols,inteiro(p&&p.colsw)||cols);
  const meia=(!preview&&p&&p.desvio)?1:0;
  const off=colsw-cols+meia;              // meias-colunas livres à esquerda
  let slots=[];
  if(formato==='sobrepostos'){
    // a fila que tem o lugar a mais (se houver) é a comprida; a outra
    // começa meia coluna à frente
    const filaCheia=mais_em==='baixo'?2:1;
    let nCima=0,nBaixo=0;
    slots=Array.from({length:capacidade},(_,i)=>{
      const row=i%2===0?filaCheia:3-filaCheia;
      const k=row===1?nCima++:nBaixo++;
      const curta=(row!==filaCheia)&&(capacidade%2===1);
      return {lugar:base+i+1,row,col:off+2*k+1+(curta?1:0),span:2};
    });
    if(capacidade===1)slots[0].row=1;
    return {formato,mais_em,capacidade,base,slots,cols,colsw,rows:capacidade>1?2:1,gridCols:2*colsw,span:2};
  }
  slots=Array.from({length:capacidade},(_,i)=>({lugar:base+i+1,col:off+2*i+1,row:1,span:2}));
  return {formato,mais_em,capacidade,base,slots,cols,colsw,rows:1,gridCols:2*colsw,span:2};
}
/* A LEITURA DO DESENHO — e é aqui que moram duas decisões.

   **Os lugares são numerados de forma CORRIDA no local**, não dentro de
   cada prateleira: um Nível 1 de 4 lugares tem 1 a 4 e o Nível 2 a seguir
   começa no 5. É como se numera uma estante a sério (cada garrafa tem um
   número só dela no móvel) e é como os dados desta app já estavam
   gravados antes de haver desenho nenhum. Cada prateleira leva por isso um
   `base` — quantos lugares vêm antes dela — e a ORDEM DO ARRAY é que
   manda: trocar prateleiras de ordem renumera os lugares.

   **Um ziguezague são DOIS níveis**, não um. Era um formato (uma
   prateleira com duas filas alternadas) e não é o que está no móvel: a
   fila de baixo e a de cima são prateleiras diferentes, com contagens
   diferentes (4 e 3, tipicamente) — foi um entendido de vinhos que o
   apontou, e os dados desta app já estavam gravados assim. Os layouts
   antigos são convertidos AQUI, ao ler, e não numa migração da base de
   dados: assim qualquer garrafeira fica certa sem ninguém correr nada, e
   os dados só mudam quando alguém guardar o local.

   Um ziguezague convertido dá DOIS níveis, e os níveis de um local são
   números seguidos: por isso, num local que teve ziguezagues, todas as
   prateleiras são renumeradas "Nível 1..N". A alternativa (a metade de
   cima ganhar " · cima") deixava o local com dois "Nível 8" e um deles
   com um sufixo — e um nível é um número, não uma nota de rodapé.
   Renumerar mexe nos NOMES, e o nome gravado na garrafa é a confirmação
   de que ela está onde diz (ver `ocupacaoLayout`) — daí o `origem`: o
   nome que a prateleira tinha antes da conversão. Uma garrafa que diga
   "Nível 8" continua a bater com o nível que veio dele, e não vai parar
   a "por posicionar" só porque o desenho passou a contar de outra
   maneira.

   O que sobra do ziguezague é o **`encaixe`**: uma marca de desenho a
   dizer que esta prateleira assenta na de baixo, desencontrada. Não muda
   nada nos lugares — só como se desenha.

   O `desvio` é o desencontro horizontal, em frações de coluna. Com as duas
   prateleiras centradas, os lugares já caem uns entre os outros quando as
   capacidades têm paridades diferentes (4 e 3): aí não é preciso desviar
   nada. Quando têm a mesma (4 e 4), ficariam alinhados e é preciso meia
   coluna. `ondulada` é quem desenha a tábua em onda: a que encaixa e a que
   está por baixo dela, para o conjunto se ler como um ziguezague. */
function layoutLocal(l){
  const raw=l&&l.layout&&Array.isArray(l.layout.prateleiras)?l.layout.prateleiras:[];
  const out=[];
  let convertido=false;
  raw.forEach((p,i)=>{
    const capacidade=Math.max(1,Math.min(240,inteiro(p&&p.capacidade)||0));
    if(!capacidade)return;
    const nome=String((p&&p.nome)||'').trim()||`Nível ${i+1}`;
    if(chave(p&&p.formato).replace(/\s+/g,'')==='ziguezague'){
      // o antigo `mais_em` dizia em que fila ficava o lugar 1; com ele em
      // cima, a fila de cima é a que leva o lugar a mais
      const nCima=normalizarSobrepostosMaisEm(p&&p.mais_em)==='cima'?Math.ceil(capacidade/2):Math.floor(capacidade/2);
      convertido=true;
      out.push({nome,origem:nome,capacidade:capacidade-nCima,formato:'fila',mais_em:'cima',encaixe:false});
      if(nCima)out.push({nome,origem:nome,capacidade:nCima,formato:'fila',mais_em:'cima',encaixe:true});
      return;
    }
    out.push({nome,origem:nome,capacidade,formato:normalizarFormatoPrateleira(p&&p.formato),
      mais_em:normalizarSobrepostosMaisEm(p&&p.mais_em),encaixe:!!(p&&p.encaixe)});
  });
  // Um local que teve ziguezagues passa a ter mais níveis do que tinha
  // prateleiras: os nomes gravados deixam de servir de numeração e são
  // refeitos de seguida. O `origem` fica a valer as garrafas antigas.
  if(convertido)out.forEach((p,i)=>{p.nome=`Nível ${i+1}`;});
  let base=0;
  out.forEach((p,i)=>{
    p.base=base;base+=p.capacidade;
    const ant=i?out[i-1]:null;
    p.encaixe=!!(p.encaixe&&ant);      // a primeira não tem em que encaixar
    p.desvio=p.encaixe?((ant.desvio||0)+(((p.capacidade-ant.capacidade)%2===0)?.5:0))%1:0;
  });
  out.forEach((p,i)=>{p.ondulada=!!(p.encaixe||(out[i+1]&&out[i+1].encaixe));});
  // A largura do móvel: o nível mais largo, mais uma coluna de folga de
  // CADA lado. Meia coluna de folga não chegava — uma prateleira desviada
  // gastava-a toda e o último lugar ficava cortado pela borda.
  const colsMax=out.reduce((m,p)=>Math.max(m,p.formato==='sobrepostos'?Math.ceil(p.capacidade/2):p.capacidade),1);
  out.forEach(p=>{p.colsw=colsMax+2;});
  return out;
}
function temLayoutLocal(l){return layoutLocal(l).length>0;}
function lugaresLocal(l){return layoutLocal(l).reduce((s,p)=>s+p.capacidade,0);}
function resumoLayoutLocal(l){
  const prats=layoutLocal(l);
  if(!prats.length)return '';
  const n=lugaresLocal(l);
  return `${prats.length} ${prats.length===1?'prateleira':'prateleiras'} · ${n} ${n===1?'lugar':'lugares'}`;
}
function lugarNumeroLayout(v){
  const s=String(v==null?'':v).trim();
  if(!s)return null;
  const n=inteiro(s);
  return n!=null&&String(n)===s?n:null;
}
/* Com a numeração corrida, o número do lugar diz sozinho em que prateleira
   ele está. */
function prateleiraDoLugar(prats,lug){
  return (prats||[]).find(p=>lug>p.base&&lug<=p.base+p.capacidade)||null;
}
function nomeDaPosicao(localId,lugar){
  const l=IDXL[localId];
  const lug=lugarNumeroLayout(lugar);
  if(!l||lug==null)return '';
  const def=prateleiraDoLugar(layoutLocal(l),lug);
  return def?def.nome:'';
}
/* O nome gravado na garrafa CONFIRMA o lugar, não o escolhe: vale se for
   o da prateleira a que o número pertence, ou o `origem` dela (o nome de
   antes de o ziguezague ter sido desdobrado e os níveis renumerados),
   ou se estiver vazio — garrafas antigas, de antes de haver desenho, que
   só têm o número. */
function nomeBatePrateleira(def,prat){
  const n=String(prat||'').trim();
  return !n||n===def.nome||n===def.origem;
}
/* Quem está em cada lugar do desenho, indexado pelo NÚMERO do lugar (que
   com a numeração corrida é único no local).

   Quando o nome CONTRADIZ o desenho a garrafa não entra — vai para "por
   posicionar", que é onde se vê que há ali uma discordância para
   resolver, em vez de a app escolher sozinha entre duas versões. */
function ocupacaoLayout(localId,ignorarGid){
  const l=IDXL[localId];
  const prats=l?layoutLocal(l):[];
  const occ={};
  db.garrafas.filter(g=>naGarrafeira(g)&&g.local_id===localId&&g.id!==ignorarGid).forEach(g=>{
    const lug=lugarNumeroLayout(g.lugar);
    if(lug==null)return;
    const def=prateleiraDoLugar(prats,lug);
    if(!def)return;
    if(!nomeBatePrateleira(def,g.prateleira))return;
    (occ[lug]=occ[lug]||[]).push(g);
  });
  return occ;
}
function posicaoTxt(prateleira,lugar){
  return [prateleira,lugar?`lugar ${lugar}`:''].filter(Boolean).join(' · ');
}
function prateleiraPreviewHTML(p){
  const info=prateleiraLayoutInfo(p,{preview:true});
  return `<span class="llprev llprev-${info.formato}" style="--cols:${info.gridCols};--rows:${info.rows}">${info.slots.map(s=>
    `<span class="llprev-dot" style="${slotGridStyle(s)}"></span>`).join('')}</span>`;
}
function dadosForaLayout(l,gs){
  const prats=layoutLocal(l);
  if(!prats.length)return [];
  return gs.filter(g=>{
    const lug=lugarNumeroLayout(g.lugar);
    if(lug==null)return true;
    const def=prateleiraDoLugar(prats,lug);
    if(!def)return true;
    return !nomeBatePrateleira(def,g.prateleira);
  }).sort((a,b)=>
    ordPrateleira(String(a.prateleira||''),String(b.prateleira||''))||
    String(a.lugar||'').localeCompare(String(b.lugar||''),'pt',{numeric:true}));
}
/* O lugar é o que se valida; a prateleira deduz-se dele. */
function validarPosicaoLayout(localId,lugar,ignorarGid){
  const l=IDXL[localId];
  if(!l||!temLayoutLocal(l))return '';
  const raw=String(lugar==null?'':lugar).trim();
  if(!raw)return '';
  const lug=lugarNumeroLayout(raw);
  if(lug==null)return 'Num local com desenho, o lugar tem de ser um número inteiro.';
  const total=lugaresLocal(l);
  if(lug<1||lug>total)return `${l.nome} vai do lugar 1 ao ${total}.`;
  if((ocupacaoLayout(localId,ignorarGid)[lug]||[]).length)
    return `O lugar ${lug} já está ocupado.`;
  return '';
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

/* ONDE dentro da janela: 0 no primeiro ano, 1 no último. Só há posição
   com as DUAS pontas e com intervalo a sério — com uma ponta só não há
   intervalo nenhum para posicionar, e uma janela de um ano era uma
   divisão por zero. Fora da janela vem encostada (0 ou 1), mas quem usa
   isto só pergunta pela posição de quem está no ponto. */
function janelaPos(v){
  if(!v.beber_de||!v.beber_ate||v.beber_ate<=v.beber_de)return null;
  const y=new Date().getFullYear();
  return Math.max(0,Math.min(1,(y-v.beber_de)/(v.beber_ate-v.beber_de)));
}
/* Os terços da janela em palavras — [limite, chave, rótulo]. É o mesmo
   vocabulário na pesquisa e na ficha do vinho, de propósito: quem filtra
   por "a fechar" tem de reconhecer a palavra quando abre o vinho.
   Sem posição não há fase, e é a mesma regra do crachá, que nesses casos
   também não se enche — assim a lista e o filtro nunca discordam. */
const FASES=[[.34,'abrir','a abrir'],[.67,'meio','a meio'],[2,'fechar','a fechar']];
function janelaFase(v){
  const p=janelaPos(v);
  return p==null?null:FASES.find(f=>p<f[0]);
}
/* O crachá da maturação. "No ponto" está em quase todos os vinhos e por
   isso deixou de separar alguma coisa: o crachá passa a ENCHER-SE até ao
   ano em que estamos, e o rebordo do enchimento é o marcador. Não é um
   crachá novo nem uma linha nova no cartão — é o mesmo, com a posição lá
   dentro (o desenho está no `.bdg.jan.cheio`, no style.css).
   Só 'ponto' se enche: em 'cedo' e 'passou' a posição era sempre o
   princípio ou o fim, e um risco encostado à borda lê-se como defeito.
   `comFase` escreve a palavra ao lado — vai a ficha do vinho, onde há
   espaço; no cartão fica só o enchimento, que não alarga o rodapé. */
function janelaBadge(v,jan,comFase){
  if(!jan)return '';
  const fase=jan==='ponto'?janelaFase(v):null;
  const p=fase?janelaPos(v):null;
  return `<span class="bdg jan ${jan}${p==null?'':' cheio'}"`
    +`${p==null?'':` style="--p:${p.toFixed(3)}"`}>`
    +`${JANELA_TXT[jan]}${comFase&&fase?' · '+fase[2]:''}</span>`;
}

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
  if(MAPA_POP_LOCAL&&!e.target.closest('#mapa-pop,.msdot.cheia'))mapaPopupFechar();
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
  // só agora a secção está visível: antes disto o `ajustarEstantes` de
  // dentro do `renderMapa` não tinha alturas para medir
  if(nome==='locais')ajustarEstantes();
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
      <div class="rdet-lista">${vs.map(v=>vinhoCardHTML(v)).join('')||'<div class="note">Sem vinhos.</div>'}</div>
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
  {k:'Sem imagem do rótulo',tem:imagemFuncional},
  {k:'Sem castas',          tem:v=>(v.castas||[]).length>0},
  {k:'Sem preço médio',     tem:v=>v.preco_medio!=null},
  {k:'Sem classificação',   tem:v=>!!v.classificacao},
  {k:'Sem nota Vivino',     tem:v=>v.vivino_nota!=null},
  {k:'Sem informação de harmonização',       tem:v=>!!v.harmonizacao},
  {k:'Sem informação de intervalo de consumo',tem:v=>v.beber_de!=null||v.beber_ate!=null}
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
  // "No ponto" sozinho não era um filtro — está em quase todos os vinhos e
  // devolvia a lista quase inteira. O que se pergunta a seguir é em que
  // parte da janela: por isso o ponto abre nos três terços (as mesmas
  // palavras que a ficha do vinho escreve), e o valor leva a fase atrás
  // ('ponto:fechar'). "A fechar" é a lista do que se deve beber primeiro.
  o.janela=[...FASES.map(f=>['ponto:'+f[1],'No ponto · '+f[2]]),
    ['cedo','Ainda cedo'],['passou','Já passou']];
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
// Só o ESTADO, sem desenhar. Quem troca de garrafeira precisa de esquecer
// os filtros ANTES de os dados novos chegarem, e um `renderFiltrados()` aqui
// desenhava a garrafeira anterior mais uma vez, já sem filtros — um piscar
// de olhos com a lista de outra pessoa.
function esquecerFiltros(){
  Object.keys(F).forEach(k=>F[k]='');
  const t=document.getElementById('f-texto');
  if(t)t.value='';
}
function limparFiltros(){
  esquecerFiltros();
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

// Os termos da caixa de procura, tal como `vinhosFiltrados` os usa — o
// cartão precisa dos MESMOS para dizer onde encontrou a palavra.
function termosProcura(){
  const c=document.getElementById('f-texto');
  return c?chave(c.value).split(/\s+/).filter(Boolean):[];
}

/* ── ONDE É QUE A PALAVRA ESTAVA ────────────────────────────────────
   A procura livre lê muito mais do que o cartão mostra: sub-região, notas
   de prova, harmonização, as minhas notas. Procurar "caça" devolvia vinhos
   sem uma única letra da palavra à vista — a lista respondia certo e
   parecia enganada.
   Por isso, e SÓ enquanto se procura por texto, o cartão ganha uma última
   faixa com o campo onde a palavra apareceu e o pedaço à volta dela, com a
   palavra sombreada. Não é uma quarta zona da identidade do vinho (essas
   continuam três, ver `vinhoCardHTML`): é a procura a mostrar o seu
   trabalho, e desaparece com ela.
   Só entra o que NÃO se vê no cartão: um termo que já está no nome, no
   produtor, na região, no ano ou nas castas visíveis não precisa de ser
   repetido por baixo — quem procurou "esporão" está a ver "Esporão" em
   serifa a três centímetros dali. Termo a termo: "esporao caça" mostra onde
   está a "caça" e cala-se sobre o nome.
   Aparecem TODOS os campos onde a palavra está, pela ordem da ficha do
   vinho: um vinho com "caça" nas notas de prova e na harmonização dá as
   duas linhas, e são duas respostas diferentes ("sabe a" e "come-se com").
   O tecto de MAX_MATCH linhas é só para o cartão não crescer sem fim num
   vinho com a palavra em todo o lado. */
const MAX_MATCH=3;
const CAMPOS_MATCH=[
  ['Sub-região',    v=>v.sub_regiao],
  // As duas primeiras castas já estão no cartão; as que o "+2" esconde é
  // que precisam de ser ditas, e só as que deram match.
  ['Casta',         (v,t)=>(v.castas||[]).slice(2).filter(c=>t.some(x=>chave(c).includes(x))).join(' · ')],
  ['Notas de prova',v=>v.notas_prova],
  ['Harmoniza com', v=>v.harmonizacao],
  ['As minhas notas',v=>v.notas]
];
function trechosMatch(v,termos){
  if(!termos||!termos.length)return '';
  const visivel=chave([v.nome,v.produtor,v.tipo,v.estilo,v.regiao,v.mencao,v.ano,
    (v.castas||[]).slice(0,2).join(' ')].join(' '));
  const porMostrar=termos.filter(t=>!visivel.includes(t));
  if(!porMostrar.length)return '';
  const linhas=[];
  for(const [rot,ler] of CAMPOS_MATCH){
    if(linhas.length===MAX_MATCH)break;
    const txt=String(ler(v,porMostrar)||'').trim();
    if(!txt)continue;
    const alvo=chave(txt);
    const presentes=porMostrar.filter(t=>alvo.includes(t));
    if(!presentes.length)continue;
    linhas.push(`<div class="vcm-l"><span class="vcm-k">${esc(rot)}</span>`+
      `<span class="vcm-t">${trechoRealcado(txt,presentes)}</span></div>`);
  }
  return linhas.length?`<div class="vc-match">${linhas.join('')}</div>`:'';
}
// Normaliza SEM mexer nas posições: `chave()` caracter a caracter, e quem
// não devolver exatamente um caracter fica como estava. É preciso porque o
// `chave()` normal (NFD + tirar acentos) encurta a string — os índices do
// match deixavam de servir para cortar o texto ORIGINAL, que é o que se
// mostra (com acentos e maiúsculas).
function normPos(s){
  let out='';
  for(const c of s){const n=chave(c);out+=(n.length===1?n:c);}
  return out;
}
// O pedaço de texto à volta do primeiro match, com TODOS os termos
// sombreados lá dentro. Uma nota de prova inteira não cabe no cartão nem
// interessa aqui: o que se quer ver é a palavra que se procurou e o que ela
// tem à volta. Corta a espaços para não partir palavras a meio.
// A janela NÃO é centrada no match: leva só uma migalha de contexto à
// frente (`ANTES`) e o resto atrás. Centrada — ou sem janela nenhuma num
// texto curto — a palavra caía na terceira linha do trecho, e o trecho
// corta às duas (`.vcm-t`): a faixa existia para mostrar a palavra e era
// exatamente a palavra que ficava de fora. Por isso a janela também abre
// quando o texto até cabe em `max` mas o match está lá para o fim: o que
// manda é a palavra apanhar a PRIMEIRA linha, não o tamanho do texto.
// (E por isso a janela nunca recua para trás de `a-ANTES` para se encher
// no fim de um texto: encher a janela era outra vez empurrar a palavra
// para baixo.)
const ANTES=26;
function trechoRealcado(txt,termos,max=72){
  const n=normPos(txt);
  const hits=[];
  termos.forEach(t=>{for(let i=n.indexOf(t);i>=0;i=n.indexOf(t,i+1))hits.push([i,i+t.length]);});
  hits.sort((a,b)=>a[0]-b[0]);
  const juntos=[];
  hits.forEach(h=>{const u=juntos[juntos.length-1];
    if(u&&h[0]<=u[1])u[1]=Math.max(u[1],h[1]);else juntos.push(h.slice());});
  let ini=0,fim=txt.length;
  if(juntos.length&&(txt.length>max||juntos[0][0]>ANTES)){
    const [a,b]=juntos[0];
    ini=Math.max(0,a-ANTES);
    fim=Math.min(txt.length,Math.max(b,ini+max));
    if(ini>0){const e=txt.indexOf(' ',ini);if(e>=0&&e<a)ini=e+1;}
    if(fim<txt.length){const e=txt.lastIndexOf(' ',fim);if(e>b)fim=e;}
  }
  let out='',pos=ini;
  juntos.forEach(([a,b])=>{
    if(b<=ini||a>=fim)return;
    a=Math.max(a,ini);b=Math.min(b,fim);
    out+=esc(txt.slice(pos,a))+'<mark class="hl">'+esc(txt.slice(a,b))+'</mark>';
    pos=b;
  });
  out+=esc(txt.slice(pos,fim));
  return (ini>0?'… ':'')+out+(fim<txt.length?' …':'');
}
function vinhosFiltrados(){
  const termos=termosProcura();
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
    if(F.janela){
      // 'ponto:meio' → estado 'ponto' E fase 'meio'; 'cedo'/'passou' não
      // têm fase nenhuma atrás.
      const [est,fase]=F.janela.split(':');
      if(janelaBeber(v)!==est)return false;
      if(fase&&(janelaFase(v)||[])[1]!==fase)return false;
    }
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
   cor própria.
   A faixa da procura (`trechosMatch`) não é uma quarta zona: só existe
   enquanto se procura por texto, e o que diz é da PROCURA — onde é que a
   palavra estava — não do vinho. Sem procura, o cartão é exatamente o
   mesmo de sempre. */
function vinhoCardHTML(v,termos){
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
          ${janelaBadge(v,jan)}
        </div>
      </div>
    </div>
    ${trechosMatch(v,termos)}
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
  const termos=termosProcura();
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
      ${g.vinhos.map(v=>vinhoCardHTML(v,termos)).join('')}
    </div>`).join('');
}

// Dispatcher chamado depois de QUALQUER mutação (guardar, apagar, consumir,
// mover…): atualiza os três sítios que mostram vinhos, sem se preocupar com
// qual separador está aberto — o dataset é pequeno, refazer os três é mais
// simples e mais seguro do que tentar adivinhar o que precisa de mudar.
function renderLista(){
  renderResumo();
  renderFiltrados();
  verificarImagens();
}

/* ── MAPA DOS LOCAIS ───────────────────────────────────────────────
   UM local de cada vez, a ocupar o ecrã: a estante desse local nível a
   nível (`mapaLocalHTML`), cada lugar um círculo com o nº do vinho se
   está cheio ou o nº do lugar se está vazio, e ‹ › (ou arrastar de lado)
   para passar ao local seguinte. Não há vista de conjunto nem cartões de
   pré-visualização — chegou a haver (um local em destaque com a estante
   em miniatura e um cartão por local) e era um passo a mais para chegar
   às garrafas; os locais são poucos e andar de lado chega.

   `MAPA_LOCAL` é o local que está no ecrã (id da BD; fica no
   `localStorage` como preferência e só vale enquanto o local existir —
   `renderMapa()` passa ao primeiro sozinho se for apagado ou se trocar a
   garrafeira).

   Só garrafas que lá estão — o histórico dos consumos vive no separador
   próprio. Com a procura ligada, só se anda pelos locais com garrafas que
   passam nela, e os lugares ocupados por garrafas que NÃO passam ficam
   apagados — a resposta a "onde estão as minhas garrafas de Syrah" é o
   que fica a cor.

   As garrafas sem local (o local foi apagado, ou nunca foi escolhido) não
   podem sumir do mapa — é aqui que se vê que estão por arrumar. Entram
   como um local a fingir, `POR_ARRUMAR`, que não se edita. */
let MAPA_LOCAL=0;
const POR_ARRUMAR={id:-1,nome:'Por arrumar',descricao:'Garrafas sem local escolhido',cor:'#8a8a8a',layout:{prateleiras:[]}};

function mapaGrupos(){
  const filtrando=haFiltros();
  const todas=db.garrafas.filter(naGarrafeira);
  let passam=todas;
  if(filtrando){
    const okV=new Set(vinhosFiltrados().map(v=>v.id));
    passam=todas.filter(g=>okV.has(g.vinho_id)&&(!F.local||String(g.local_id)===F.local));
  }
  const okG=new Set(passam.map(g=>g.id));
  const grupos=db.locais.map(l=>({l,gs:todas.filter(g=>g.local_id===l.id)}));
  const orfas=todas.filter(g=>!IDXL[g.local_id]);
  if(orfas.length)grupos.push({l:POR_ARRUMAR,gs:orfas});
  grupos.forEach(x=>{x.n=filtrando?x.gs.filter(g=>okG.has(g.id)).length:x.gs.length;});
  return {filtrando,okG,grupos,visiveis:filtrando?grupos.filter(x=>x.n):grupos};
}
function capacidadeLocal(l){return layoutLocal(l).reduce((s,p)=>s+p.capacidade,0);}
// "37 / 45 garrafas" num local com desenho; "12 garrafas · 9 vinhos" sem
// ele; com a procura ligada, o que interessa é quantas passaram.
function mapaContagemHTML(x,d){
  const cap=capacidadeLocal(x.l);
  if(d.filtrando)return `<b>${x.n}</b> ${x.n===1?'encontrada':'encontradas'} · de ${x.gs.length}`;
  if(cap)return `<b>${x.gs.length}</b> / ${cap} garrafas`;
  const nv=new Set(x.gs.map(g=>g.vinho_id)).size;
  return `<b>${x.gs.length}</b> ${x.gs.length===1?'garrafa':'garrafas'} · ${nv} ${nv===1?'vinho':'vinhos'}`;
}

/* A prateleira desenhada em HTML: o formato dá o fundo de madeira — barra
   para a fila, bloco para os sobrepostos, fita em ziguezague por trás dos
   lugares — e a grelha põe cada lugar na coluna e fila que
   `prateleiraLayoutInfo` lhe deu. É a MESMA função para a estante do
   local e para o seletor de posição da garrafa: os lugares são o que muda
   (`slotsHTML`), a madeira não. */
/* TODAS as prateleiras de um local têm a MESMA largura — a do nível mais
   largo, mais uma coluna de folga (`colsw`) — e os lugares ficam
   centrados nela. Antes cada prateleira valia o que os seus lugares
   mediam, e uma estante de 4/3/4/3 lia-se como uma pilha de tábuas
   irregulares em vez de um móvel. A folga é o que deixa uma prateleira
   desviar-se meia coluna sem sair da caixa. */
function estanteHTML(p,info,slotsHTML,cls){
  const onda=!!(p&&p.ondulada)&&info.formato==='fila';
  return `<div class="est est-${info.formato}${onda?' est-onda':''}${cls?' '+cls:''}"
    style="--cols:${info.cols};--colsw:${info.colsw};--gcols:${info.gridCols};--span:${info.span}">${
    onda?ondaBgSVG(info,(p&&p.desvio)||0):''}${slotsHTML}</div>`;
}
// O `style` de um lugar na grelha. `span` é a unidade dos sobrepostos:
// cada lugar ocupa DUAS meias-colunas, e é isso que deixa a fila mais
// curta começar meia coluna à frente e ficar centrada.
function slotGridStyle(s){return `grid-column:${s.col} / span ${s.span||1};grid-row:${s.row}`;}
/* A TÁBUA EM ONDA das prateleiras que encaixam: os lugares assentam nos
   VALES e a madeira sobe entre eles, que é como uma prateleira de
   ziguezague é feita. Cada prateleira desenha a sua; empilhadas e
   desencontradas, leem-se como o ziguezague de sempre.

   O traço é `non-scaling-stroke` — o viewBox estica-se à caixa
   (`preserveAspectRatio:none`) e sem isso a onda ficava mais grossa nas
   diagonais do que nas pontas. */
/* A RÉGUA de uma prateleira de ziguezague: uma tira fina que corre o
   móvel todo e faz um BERÇO em U debaixo de cada lugar, subindo entre
   eles. É o que está lá em casa — as réguas onduladas onde a garrafa
   assenta deitada — e não uma tábua maciça: a primeira versão preenchia
   a metade de baixo da caixa e lia-se como um bloco de madeira com o
   cimo às ondas, não como a prateleira que é.

   O fundo do berço é achatado de propósito (as curvas entram e saem
   quase na horizontal): uma onda de seno punha a garrafa a assentar num
   ponto só, e o que segura uma garrafa é o berço inteiro.

   A tira atravessa o móvel INTEIRO (a caixa é sempre da largura do
   local), mas os berços têm de cair sob os lugares — que estão centrados
   nela e podem estar desviados meia coluna. Daí a conta do `off`. */
function ondaBgSVG(info,desvio){
  // em % da caixa, que inclui a folga de baixo onde o berço desce
  const colsw=info.colsw||info.cols,PICO=36,VALE=88;
  const larg=100/colsw;                        // uma coluna, em % da caixa
  const off=(colsw-info.cols)/2+(desvio||0);   // colunas livres à esquerda
  const f=n=>n.toFixed(2);
  /* A régua acaba logo a seguir ao último berço e não na borda da caixa.
     Atravessar o móvel todo dava-lhe dois troços RETOS e compridos, um de
     cada lado — e o que se lia era uma linha contínua a ir do nome do
     nível até ao outro extremo da linha, não uma prateleira. O que se quer
     ver são os U onde a garrafa encaixa; a pontinha é só o que segura a
     ponta. Que cada nível fique com uma régua mais curta ou mais comprida
     é o certo: é a prateleira dele, e a CAIXA continua a ser a do móvel,
     por isso os lugares alinham-se na mesma de nível para nível. */
  const PONTA=.3;                              // quanto sobra depois do berço, em colunas
  const ini=Math.max(0,(off-PONTA)*larg);
  let d=`M${f(ini)} ${PICO} L${f(off*larg)} ${PICO}`;
  info.slots.forEach((s,i)=>{
    const cx=(off+i+.5)*larg, e=cx-larg/2, dir=cx+larg/2;
    d+=` C${f(e+larg*.24)} ${PICO} ${f(cx-larg*.26)} ${VALE} ${f(cx)} ${VALE}`;
    d+=` C${f(cx+larg*.26)} ${VALE} ${f(dir-larg*.24)} ${PICO} ${f(dir)} ${PICO}`;
  });
  d+=` L${f(Math.min(100,(off+info.slots.length+PONTA)*larg))} ${PICO}`;
  return `<svg class="est-bg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" class="est-reg-s" transform="translate(0 5)"/><path d="${d}" class="est-reg"/>
  </svg>`;
}

function mapaCelulaListaHTML(g){
  const v=IDXV[g.vinho_id]||{nome:'?'};
  return `<button class="mcell" onclick="verVinho(${g.vinho_id})" title="${esc(v.nome)} ${v.ano||''}">
    ${garrafaSVG(v,1)}
    <span class="mcell-tx"><b>${esc(v.nome)}</b><span>${v.ano||'s/ ano'}</span></span>
    ${g.lugar?`<span class="mlug">${esc(g.lugar)}</span>`:''}
  </button>`;
}
// Um local SEM desenho: as prateleiras que as garrafas dizem ter, cada
// uma com a lista das garrafas.
function mapaLocalListaHTML(gs,d){
  const lista=d.filtrando?gs.filter(g=>d.okG.has(g.id)):gs;
  if(!lista.length)return '<div class="vazio ml-vazio"><b>Sem garrafas</b>Ainda não há garrafas arrumadas neste local.</div>';
  const prats=[...new Set(lista.map(g=>g.prateleira||''))].sort((a,b)=>ordPrateleira(b,a));
  return prats.map(p=>{
    const cel=lista.filter(g=>(g.prateleira||'')===p)
      .sort((a,b)=>String(a.lugar).localeCompare(String(b.lugar),'pt',{numeric:true}));
    return `<div class="mprat">
      <div class="mprat-t">${esc(p||'Sem prateleira')}
        <span class="mprat-n">${cel.length} ${cel.length===1?'garrafa':'garrafas'}</span></div>
      <div class="mgrid">${cel.map(mapaCelulaListaHTML).join('')}</div>
    </div>`;
  }).join('');
}
// Um local COM desenho: nível a nível, de cima para baixo como na estante
// a sério (o Nível 1 é o de baixo).
function mapaEstanteHTML(l,gs,d){
  const prats=prateleirasDesc(layoutLocal(l));
  const occ=ocupacaoLayout(l.id);
  const extras=dadosForaLayout(l,gs).filter(g=>!d.filtrando||d.okG.has(g.id));
  return prats.map(p=>{
    const info=prateleiraLayoutInfo(p);
    const slots=info.slots.map(s=>{
      const lugar=s.lugar,lista=occ[lugar]||[];
      const pos=` style="${slotGridStyle(s)}"`;
      if(!lista.length)return `<button class="msdot vazia"${pos}
        onclick="mapaLugarVazio(${l.id},'${escJs(p.nome)}',${lugar})"
        title="${esc(posicaoTxt(p.nome,lugar))} — vazio"><span class="msdot-id">${lugar}</span></button>`;
      const passam=d.filtrando?lista.filter(g=>d.okG.has(g.id)):lista;
      const g=passam[0]||lista[0],v=IDXV[g.vinho_id]||{nome:'?'};
      return `<button class="msdot cheia${lista.length>1?' conflito':''}${d.filtrando&&!passam.length?' fora':''}"${pos}
        onclick="mapaPopupToggle(${l.id},'${escJs(p.nome)}',${lugar},this,event)"
        onmouseenter="mapaPopupHover(${l.id},'${escJs(p.nome)}',${lugar},this)" onmouseleave="mapaPopupSair()"
        title="${esc(v.nome)} ${v.ano||''} · ${esc(posicaoTxt(p.nome,lugar))}${lista.length>1?` · ${lista.length} garrafas`:''}">
        <span class="msdot-id">${g.vinho_id}</span>
        ${lista.length>1?`<span class="msdot-q">×${lista.length}</span>`:''}
      </button>`;
    }).join('');
    return `<div class="mprat-layout${p.encaixe?' encaixa':''}">
      <span class="mp-lbl">${esc(p.nome)}</span>
      <span class="mp-fio"></span>
      <div class="est-wrap">${estanteHTML(p,info,slots)}</div>
      <span class="mp-esp"></span>
    </div>`;
  }).join('')+`
    <div class="ml-leg"><span><i class="cheia"></i>Ocupado · nº do vinho</span><span><i class="vazia"></i>Vazio · nº do lugar</span></div>`;
}
/* As garrafas que estão NESTE local mas sem um lugar válido no desenho.
   Ficam FORA do cartão e FECHADAS (`<details>`): são uma lista que pode
   ter dezenas de linhas — numa garrafeira acabada de importar são quase
   todas — e aberta empurrava a estante para fora do ecrã, que é
   exatamente o que este separador não pode fazer. Quem as quer ver
   rola até elas e abre. */
function mapaExtrasHTML(l,gs,d){
  const extras=dadosForaLayout(l,gs).filter(g=>!d.filtrando||d.okG.has(g.id));
  if(!extras.length)return '';
  return `<details class="ml-extras">
    <summary><b>${extras.length}</b> ${extras.length===1?'garrafa por posicionar':'garrafas por posicionar'}</summary>
    <div class="note">Estão neste local, mas ainda sem um lugar válido no desenho. Toca num lugar vazio da estante para lá pôr uma.</div>
    <div class="mgrid">${extras.map(mapaCelulaListaHTML).join('')}</div>
  </details>`;
}

/* O ecrã de um local: barra com ‹ e › para os locais vizinhos, o nome
   (com ✎ ao lado, para quem pode editar) e a contagem; os pontos dizem em
   que local se está; depois a estante. Os ‹ › dão a volta (do último
   passa ao primeiro), como o arrastar. */
function mapaLocalHTML(x,d){
  const l=x.l,pseudo=l.id<0,vis=d.visiveis,varios=vis.length>1;
  const i=vis.findIndex(y=>y.l.id===l.id);
  return `<div class="ml" style="--lc:${esc(l.cor||'#7b1f3d')}">
    <div class="ml-bar">
      <button class="ml-nav" onclick="mapaLocalIr(-1)" aria-label="Local anterior"${varios?'':' disabled'}>‹</button>
      <div class="ml-t">
        <h3>${esc(l.nome)}${pseudo?'':`<button class="ml-edit ro-hide" onclick="editarLocal(${l.id})" title="Editar local" aria-label="Editar local">✎</button>`}</h3>
        <div class="ml-sub">${mapaContagemHTML(x,d)}${!pseudo&&l.descricao?` <i>· ${esc(l.descricao)}</i>`:''}</div>
      </div>
      <button class="ml-nav" onclick="mapaLocalIr(1)" aria-label="Local seguinte"${varios?'':' disabled'}>›</button>
    </div>
    ${varios?`<div class="ml-dots">${vis.map((y,j)=>`<button class="ml-dot${j===i?' on':''}" onclick="mapaLocalMostrar(${y.l.id})" aria-label="${esc(y.l.nome)}" title="${esc(y.l.nome)}"></button>`).join('')}</div>`:''}
    ${pseudo?`<div class="note ml-nota">${esc(l.descricao)}. Abre cada vinho e usa "Mover" para lhes dar um local.</div>`:''}
    ${temLayoutLocal(l)?mapaEstanteHTML(l,x.gs,d):mapaLocalListaHTML(x.gs,d)}
  </div>
  ${temLayoutLocal(l)?mapaExtrasHTML(l,x.gs,d):''}
  <div class="ml-add ro-hide"><button class="btn ghost" onclick="novoLocal()">+ Novo local</button></div>`;
}
/* A ESTANTE INTEIRA NUM ECRÃ, sem scroll — é para isso que existe o
   `--slot`. Quantos níveis uma pessoa tem, e quantos lugares cada um, é
   coisa dela: um tamanho fixo cabia numa garrafeira de três níveis e
   obrigava a rolar meia página numa de oito. Aqui mede-se o que sobra do
   ecrã abaixo do mapa e escolhe-se o maior lugar que ainda cabe.

   Por BISSECÇÃO e não por conta: a altura depende de paddings, do número
   de filas de cada formato, das margens negativas do ziguezague e de
   quanto o nome de cada prateleira quebra de linha — refazer essa conta
   aqui era duplicar o `style.css` e ficar a discordar dele no dia em que
   alguém lhe mexesse. Seis passos chegam para acertar a menos de 1px, e
   isto corre uma vez por desenho do mapa (não a cada scroll).

   `SLOT_MIN` é onde se desiste: abaixo disso o número do vinho não se lê
   nem se acerta com o dedo, e é preferível deixar rolar. Medimos com o
   scroll onde estiver (`rect.top + scrollY` é a posição no documento) —
   o que interessa é caber quando se chega ao separador, com a página no
   topo. */
const SLOT_MIN=18, SLOT_MAX=54;
function ajustarEstantes(){
  const box=document.getElementById('mapa');
  const ml=box&&box.querySelector('.ml');
  // escondido (o `renderFiltrados` refaz Locais mesmo fora dele) — medir
  // um `display:none` dá zeros e punha tudo no mínimo
  if(!ml||!box.offsetParent)return;
  // O + flutuante (adicionar vinho) fica POR CIMA do canto de baixo à
  // direita, que é onde acaba o último nível — e com tudo a caber no ecrã
  // já não há scroll que o desvie. Por isso o cartão tem de acabar antes
  // dele: senão o último lugar da última prateleira ficava por baixo do
  // botão, à vista e sem se conseguir tocar.
  // `offsetParent` de um elemento `position:fixed` é SEMPRE null (é regra
  // do DOM, não um sinal de estar escondido) — por isso o FAB mede-se pelo
  // retângulo. O que se reserva é o que ele ocupa acima do fundo, menos a
  // faixa que o cartão já não usa para lugares (a legenda no fim).
  const fab=document.querySelector('.fab');
  const r=fab?fab.getBoundingClientRect():null;
  const reserva=r&&r.height?Math.max(0,window.innerHeight-r.top-32):0;
  const disponivel=window.innerHeight-(ml.getBoundingClientRect().top+window.scrollY)-10-reserva;
  if(disponivel<120)return;
  // o alvo é o CARTÃO DO LOCAL e não o separador todo: o "+ Novo local"
  // que vem por baixo é uma ação, não faz parte da estante, e obrigar a
  // que ele também coubesse custava dois pixels em cada lugar
  const alturaCom=v=>{ml.style.setProperty('--slot',v.toFixed(1)+'px');return ml.offsetHeight;};
  /* A ALTURA decide o TAMANHO do lugar; a LARGURA decide o ESPAÇO entre
     lugares. São duas coisas e não uma: numa estante com poucos lugares
     por nível há largura de sobra e as garrafas devem respirar, que é o
     que a faz ler-se como uma estante; numa com muitos, aperta-se o
     espaçamento antes de encolher a garrafa. Daí `--colr` — quanto mede
     uma coluna, em lugares — sair daqui e não do CSS. */
  const linha=ml.querySelector('.mprat-layout');
  const colsw=[...ml.querySelectorAll('.est')].reduce((m,e)=>
    Math.max(m,parseFloat(getComputedStyle(e).getPropertyValue('--colsw'))||1),1);
  // o espaço que a prateleira tem: a linha menos o nome, as folgas do
  // `.est-wrap` e o mínimo que o fio e o espaçador precisam para a estante
  // continuar CENTRADA. Medir o `.est-wrap` não servia — ele encolhe ao que
  // a estante mede, e a estante mede o que o lugar der: era circular.
  const larg=el=>el?el.getBoundingClientRect().width:0;
  const livre=linha?linha.clientWidth-larg(linha.querySelector('.mp-lbl'))-80:0;
  /* Uma coluna mede pouco mais do que um lugar de propósito: é o que põe
     as garrafas quase encostadas, e é isso que faz o ENCAIXE existir —
     com colunas largas, a garrafa de cima cai meia coluna à frente mas
     no meio de um vão onde cabia outra, e não entre duas. Era 1,28–1,8
     ("as garrafas devem respirar") e o resultado foram filas soltas em
     vez de um ziguezague. */
  const COL_MIN=1.06,COL_MAX=1.3;
  const ajustar=v=>{
    const r=livre>0?Math.min(COL_MAX,Math.max(COL_MIN,livre/(colsw*v))):COL_MAX;
    ml.style.setProperty('--colr',r.toFixed(3));
    return alturaCom(v);
  };
  const teto=Math.max(SLOT_MIN,livre>0?Math.min(SLOT_MAX,livre/(colsw*COL_MIN)):SLOT_MAX);
  if(ajustar(teto)<=disponivel)return;
  if(ajustar(SLOT_MIN)>disponivel)return;       // nem no mínimo cabe: fica no mínimo e rola
  let lo=SLOT_MIN,hi=teto;
  for(let i=0;i<6;i++){const m=(lo+hi)/2;if(ajustar(m)<=disponivel)lo=m;else hi=m;}
  ajustar(lo);
}
let _estT=null;
window.addEventListener('resize',()=>{clearTimeout(_estT);_estT=setTimeout(ajustarEstantes,120);});

function renderMapa(){
  const box=document.getElementById('mapa');
  if(!box)return;
  mapaPopupFechar();
  const d=mapaGrupos();
  const vis=d.visiveis;
  if(!vis.length){
    box.innerHTML=d.filtrando
      ?'<div class="vazio"><b>Nada encontrado</b>Nenhuma garrafa corresponde a esta procura.</div>'
      :`<div class="vazio"><b>Ainda não há locais</b>Cria o primeiro sítio onde as garrafas moram — e, se quiseres, desenha-lhe as prateleiras.
          <div class="ro-hide"><button class="btn prim" onclick="novoLocal()">+ Novo local</button></div></div>`;
    return;
  }
  if(!MAPA_LOCAL){let t=0;try{t=parseInt(localStorage.getItem('gf_local')||'0',10)||0;}catch(e){}MAPA_LOCAL=t;}
  let x=vis.find(y=>y.l.id===MAPA_LOCAL);
  if(!x){x=vis[0];MAPA_LOCAL=x.l.id;}
  box.innerHTML=mapaLocalHTML(x,d);
  mapaSwipe(box.querySelector('.ml'));
  ajustarEstantes();
}
function mapaLocalMostrar(id){
  MAPA_LOCAL=id;
  try{localStorage.setItem('gf_local',String(id));}catch(e){}
  renderMapa();
  window.scrollTo({top:0,behavior:'instant'});
}
function mapaLocalIr(dir){
  const vis=mapaGrupos().visiveis;
  if(vis.length<2)return;
  const i=Math.max(0,vis.findIndex(x=>x.l.id===MAPA_LOCAL));
  mapaLocalMostrar(vis[(i+dir+vis.length)%vis.length].l.id);
}
// Arrastar de lado passa ao local seguinte/anterior. Só pega num gesto
// claramente horizontal (senão roubava o scroll da página), e nunca numa
// prateleira que rola de lado por ser mais larga do que o ecrã — aí o
// gesto é dela.
function mapaSwipe(el){
  if(!el)return;
  let x0=null,y0=null;
  el.addEventListener('touchstart',e=>{
    const t=e.touches[0];x0=t.clientX;y0=t.clientY;
    const w=e.target.closest&&e.target.closest('.est-wrap');
    if(w&&w.scrollWidth>w.clientWidth+2)x0=null;
  },{passive:true});
  el.addEventListener('touchend',e=>{
    if(x0==null)return;
    const t=e.changedTouches[0],dx=t.clientX-x0,dy=t.clientY-y0;x0=null;
    if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)*1.5)mapaLocalIr(dx<0?1:-1);
  },{passive:true});
}
let MAPA_POP_LOCAL=0, MAPA_POP_PRAT='', MAPA_POP_LUGAR=0, MAPA_POP_FIXA=false, MAPA_POP_ANCHOR=null, MAPA_POP_T=null;
function mapaPopupNode(){
  let el=document.getElementById('mapa-pop');
  if(el)return el;
  el=document.createElement('div');
  el.id='mapa-pop';
  el.className='mspot-pop';
  el.onmouseenter=()=>clearTimeout(MAPA_POP_T);
  el.onmouseleave=()=>{if(!MAPA_POP_FIXA)mapaPopupSair();};
  document.body.appendChild(el);
  return el;
}
function mapaPopupFechar(){
  clearTimeout(MAPA_POP_T);
  MAPA_POP_LOCAL=0;MAPA_POP_PRAT='';MAPA_POP_LUGAR=0;MAPA_POP_FIXA=false;MAPA_POP_ANCHOR=null;
  const el=document.getElementById('mapa-pop');
  if(el){el.classList.remove('on');el.innerHTML='';}
}
function mapaPopupSair(){
  clearTimeout(MAPA_POP_T);
  if(MAPA_POP_FIXA)return;
  MAPA_POP_T=setTimeout(()=>{if(!MAPA_POP_FIXA)mapaPopupFechar();},120);
}
function mapaPopupPos(anchor){
  const el=document.getElementById('mapa-pop');
  if(!el||!anchor||!anchor.isConnected)return mapaPopupFechar();
  const r=anchor.getBoundingClientRect();
  el.style.left='-9999px';el.style.top='-9999px';
  const w=Math.min(el.offsetWidth||290,window.innerWidth-16);
  const h=el.offsetHeight||180;
  const left=Math.max(8,Math.min(window.innerWidth-w-8,r.left+r.width/2-w/2));
  let top=r.top-h-10,dir='top';
  if(top<8){top=r.bottom+10;dir='bottom';}
  el.dataset.dir=dir;
  el.style.left=left+'px';
  el.style.top=Math.max(8,top)+'px';
}
function mapaPopupItemHTML(g,total){
  const v=IDXV[g.vinho_id]||{nome:'?'};
  const img=imagemDe(v);
  const reg=[v.regiao,v.sub_regiao].filter(Boolean).join(' · ');
  return `<div class="mspot-item">
    <div class="mspot-top">
      <div class="mspot-thumb">${garrafaSVG(v)}
        ${img?`<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">`:''}
      </div>
      <div class="mspot-tx">
        <div class="mspot-nome">${esc(v.nome)}</div>
        <div class="mspot-meta">${v.ano||'s/ ano'}${reg?` · ${esc(reg)}`:''}</div>
        ${total>1?`<div class="mspot-aux">Uma das ${total} garrafas neste lugar.</div>`:''}
      </div>
    </div>
    <div class="mspot-actions">
      <button type="button" class="mini" onclick="mapaPopupSubstituir(${g.id})">Substituir vinho</button>
      <button type="button" class="mini" onclick="mapaPopupMover(${g.id})">Mover vinho</button>
      <button type="button" class="mini p" onclick="mapaPopupVerDetalhe(${g.id})">Ver detalhe</button>
    </div>
  </div>`;
}
function mapaPopupHTML(localId,prateleira,lugar,lista){
  return `<div class="mspot-card">
    <div class="mspot-head">${esc(nomeLocal(localId))} · ${esc(posicaoTxt(prateleira,lugar))}</div>
    ${lista.map(g=>mapaPopupItemHTML(g,lista.length)).join('')}
  </div>`;
}
function mapaPopupMostrar(localId,prateleira,lugar,anchor,fixa){
  const lista=(ocupacaoLayout(localId)[lugar]||[]).filter(naGarrafeira);
  if(!lista.length||!anchor)return;
  clearTimeout(MAPA_POP_T);
  MAPA_POP_LOCAL=localId;MAPA_POP_PRAT=prateleira;MAPA_POP_LUGAR=lugar;MAPA_POP_FIXA=!!fixa;MAPA_POP_ANCHOR=anchor;
  const el=mapaPopupNode();
  el.innerHTML=mapaPopupHTML(localId,prateleira,lugar,lista);
  el.classList.add('on');
  mapaPopupPos(anchor);
}
function mapaPopupHover(localId,prateleira,lugar,anchor){
  if(!window.matchMedia||!window.matchMedia('(hover:hover)').matches)return;
  if(MAPA_POP_FIXA)return;
  mapaPopupMostrar(localId,prateleira,lugar,anchor,false);
}
function mapaPopupToggle(localId,prateleira,lugar,anchor,ev){
  if(ev)ev.stopPropagation();
  if(MAPA_POP_FIXA&&MAPA_POP_LOCAL===localId&&MAPA_POP_PRAT===prateleira&&MAPA_POP_LUGAR===lugar){mapaPopupFechar();return;}
  mapaPopupMostrar(localId,prateleira,lugar,anchor,true);
}
function mapaPopupVerDetalhe(gid){
  const g=db.garrafas.find(x=>x.id===gid&&naGarrafeira(x));
  mapaPopupFechar();
  if(g)verVinho(g.vinho_id);
}
function mapaPopupMover(gid){
  mapaPopupFechar();
  abrirGarrafa(gid);
}
/* TOCAR NUM LUGAR VAZIO é a outra metade de "onde está o quê": até aqui
   só os lugares ocupados respondiam, e a única forma de arrumar uma
   garrafa era abrir o vinho e usar "Mover" — ou seja, saber de antemão
   qual o vinho, quando a pergunta que se faz à frente da estante é a
   inversa ("este buraco, o que é que lhe ponho?").

   O que se guarda depende do que já existe, e é isso que evita duplicar:
   se houver uma garrafa DESTE vinho por arrumar (sem lugar), é ELA que se
   move para aqui — preferindo uma que já esteja neste local; só quando não
   há nenhuma é que se acrescenta uma garrafa nova. Numa garrafeira
   acabada de importar está tudo por arrumar, e sem isto cada toque criava
   uma segunda garrafa do mesmo vinho e a contagem inflava sozinha. */
function mapaLugarVazio(localId,prateleira,lugar){
  if(roGuard())return;
  const l=IDXL[localId];if(!l)return;
  if(!db.vinhos.length){toast('Ainda não há vinhos para pôr aqui',1);return;}
  const soltas={};
  db.garrafas.filter(g=>naGarrafeira(g)&&!lugarNumeroLayout(g.lugar))
    .forEach(g=>{soltas[g.vinho_id]=(soltas[g.vinho_id]||0)+1;});
  const ordenados=[...db.vinhos].sort((a,b)=>
    String(a.nome||'').localeCompare(String(b.nome||''),'pt',{numeric:true,sensitivity:'base'})||
    String(a.ano||'').localeCompare(String(b.ano||''),'pt',{numeric:true}));
  const opt=v=>`<option value="${v.id}">${esc(v.nome)}${v.ano?` · ${esc(v.ano)}`:''}${soltas[v.id]?` · ${soltas[v.id]} por arrumar`:''}</option>`;
  // os que têm garrafas por arrumar vêm num grupo à parte e primeiro: são
  // a resposta provável a "o que é que ponho aqui"
  const comSoltas=ordenados.filter(v=>soltas[v.id]);
  document.getElementById('modal-lugar-in').innerHTML=`
    <div class="mtop"><div><h3>Pôr um vinho aqui</h3>
      <div class="note" style="margin-top:3px">${esc(l.nome)} · ${esc(posicaoTxt(prateleira,lugar))}</div></div>
      <button class="mx" onclick="fecharModal('modal-lugar')">✕</button></div>
    <label>Vinho</label>
    <select id="lv-vinho">
      ${comSoltas.length?`<optgroup label="Por arrumar">${comSoltas.map(opt).join('')}</optgroup>
      <optgroup label="Todos os vinhos">${ordenados.map(opt).join('')}</optgroup>`:ordenados.map(opt).join('')}
    </select>
    <div class="note">Se houver uma garrafa deste vinho por arrumar, é essa que vem para aqui. Se não houver, acrescenta-se uma.</div>
    <div class="macoes">
      <button class="btn prim" id="lv-btn" onclick="guardarLugarVazio(${localId},'${escJs(prateleira)}',${lugar})">Guardar</button>
      <button class="btn ghost" onclick="fecharModal('modal-lugar')">Cancelar</button>
    </div>`;
  abrirModal('modal-lugar');
}
async function guardarLugarVazio(localId,prateleira,lugar){
  if(roGuard())return;
  const sel=document.getElementById('lv-vinho');
  const vinhoId=sel&&sel.value?parseInt(sel.value,10):0;
  if(!vinhoId){toast('Escolhe um vinho',1);return;}
  const erro=validarPosicaoLayout(localId,lugar);
  if(erro){toast(erro,1);return;}
  const dados={local_id:localId,prateleira,lugar:String(lugar)};
  // uma garrafa deste vinho que ainda não tenha lugar; a que já está neste
  // local ganha à que está noutro sítio ou sem local nenhum
  const solta=db.garrafas.filter(g=>naGarrafeira(g)&&g.vinho_id===vinhoId&&!lugarNumeroLayout(g.lugar))
    .sort((a,b)=>(b.local_id===localId?1:0)-(a.local_id===localId?1:0))[0];
  const btn=document.getElementById('lv-btn');
  btn.disabled=true;btn.textContent='A guardar…';
  try{
    if(solta){
      await sbReq('PATCH',`garrafas?id=eq.${solta.id}`,dados);
      Object.assign(solta,dados);
    }else{
      const r=await sbReq('POST','garrafas',[Object.assign({vinho_id:vinhoId},dados)],{'Prefer':'return=representation'});
      (r||[]).forEach(g=>db.garrafas.push(g));
    }
    reindexar();fecharModal('modal-lugar');renderLista();refrescarVinhoAberto();
    toast(solta?'Garrafa arrumada ✓':'Garrafa acrescentada ✓');
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    btn.disabled=false;btn.textContent='Guardar';
  }
}
function mapaPopupSubstituir(gid){
  mapaPopupFechar();
  abrirSubstituirGarrafa(gid);
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
  pgMedirEncolhe();           // e com o cabeçalho por inteiro
  pgEntrarHistoria();
}
function refrescarVinhoAberto(){
  if(VINHO_ABERTO!=null&&document.getElementById('modal-vinho').classList.contains('on')){
    const v=IDXV[VINHO_ABERTO];
    // Refazer o HTML deita fora o cabeçalho (e com ele as medidas do
    // encolher), mas o scroll fica onde estava — daí o acerto a seguir.
    if(v){document.getElementById('modal-vinho-in').innerHTML=vinhoDetalheHTML(v);pgMedirEncolhe();}
  }
}

/* ── A PÁGINA DO VINHO (comportamento) ─────────────────────────────
   A pele está no style.css ("PÁGINA DO VINHO"); aqui está o que se
   mexe: o cabeçalho a encolher ao rolar, o botão de voltar do
   telemóvel e o arrastar de lado para sair. */
function pgVinho(){return document.getElementById('modal-vinho');}

/* O cabeçalho não tem dois estados, tem um cursor: `--pg` vai de 0 (por
   inteiro) a 1 (a barra encolhida) ao longo do scroll, e o style.css
   desenha cada medida com `calc()`. Uma classe ligada a partir de um
   limiar dava o mesmo resultado num salto só — que é exatamente o que se
   sentia.

   As duas alturas do cabeçalho são MEDIDAS e não números à sorte:
   dependem do nome do vinho (uma linha ou três). Servem para duas coisas.

   Primeira: o scroll que se gasta a encolher é exatamente o que o
   cabeçalho liberta (`PG_H0-PG_H1`). Como a ficha começa por baixo dele
   (o `padding-top` da `.mbox`, que não muda), as duas contas dão a mesma
   e o primeiro pixel da ficha anda COLADO ao rebordo de baixo do
   cabeçalho enquanto ele fecha — nada é engolido pelo caminho.

   Segunda: a altura é IMPOSTA a cada passo, em vez de sair do que estiver
   lá dentro. Sem isso a curva não era linear — o nome a perder uma linha,
   ou as duas pastilhas a caberem finalmente na mesma, tiravam 30px de uma
   vez a meio do caminho, e sentia-se. Com a altura imposta, o que reflui
   lá dentro fica escondido pelo `overflow:hidden` e centrado pelo
   `justify-content` — a moldura desce sempre ao mesmo ritmo. Custa meia
   dúzia de `offsetHeight` por vinho aberto. */
let PG_H0=200,PG_H1=70,PG_LINHAS=1,PG_TAB=[];
function pgMedirEncolhe(){
  const h=pgVinho().querySelector('.mhero');
  if(!h)return;
  const t=h.querySelector('h3');
  const alturaCom=(n,pg)=>{
    if(t)t.style.webkitLineClamp=n?String(n):'';
    h.style.setProperty('--pg',pg);
    return h.offsetHeight;
  };
  h.style.height='';
  PG_TAB=[];
  // Quanto ocupa a linha da origem (uma linha ou duas): é o que a faz
  // fechar-se a direito em vez de ficar parada e só depois cair.
  h.style.setProperty('--pg-hs','999');
  h.style.setProperty('--pg','0');
  const sub=h.querySelector('.mhero-s');
  h.style.setProperty('--pg-hs',String(sub?sub.offsetHeight:0));
  // Quantas linhas ocupa este nome por inteiro, e quanto mede o cabeçalho
  // com cada número de linhas, aberto e fechado. São meia dúzia de
  // medições por vinho aberto e poupam a `pgCabecalho()` de adivinhar.
  alturaCom(0,'0');
  const lh=t?(parseFloat(getComputedStyle(t).lineHeight)||25):25;
  PG_LINHAS=t?Math.max(1,Math.round(t.offsetHeight/lh)):1;
  for(let n=1;n<=PG_LINHAS;n++)PG_TAB[n]=[alturaCom(n,'0'),alturaCom(n,'1')];
  PG_H0=PG_TAB[PG_LINHAS][0];   // por inteiro: todas as linhas do nome
  PG_H1=PG_TAB[1][1];           // barra: uma linha só
  // O cabeçalho está fora do fluxo (ver style.css): é este espaço que
  // faz a ficha começar por baixo dele em vez de lhe ficar atrás.
  const cx=document.getElementById('modal-vinho-in');
  if(cx)cx.style.paddingTop=PG_H0+'px';
  pgCabecalho();
}
function pgCabecalho(){
  const p=pgVinho(),h=p.querySelector('.mhero');
  if(!h||!PG_TAB.length)return;
  const percurso=Math.max(60,PG_H0-PG_H1);
  const v=Math.min(1,Math.max(0,p.scrollTop/percurso));
  const caixa=PG_H0-(PG_H0-PG_H1)*v;
  h.style.setProperty('--pg',v.toFixed(3));
  h.style.height=caixa.toFixed(1)+'px';
  // O nome fica com as linhas que CABEM na moldura de agora — nem a mais
  // (texto cortado) nem a menos (um vazio bordô a meio do caminho).
  const t=h.querySelector('h3');
  if(!t)return;
  let n=1;
  for(let k=PG_LINHAS;k>1;k--){
    const [a,b]=PG_TAB[k];
    if(a+(b-a)*v<=caixa+0.5){n=k;break;}
  }
  t.style.webkitLineClamp=String(n);
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
   rolar (ver "PÁGINA DO VINHO"). Só tem o ✕ — um ‹ à esquerda recuava a
   coluna do nome 40px para repetir o que o ✕ e o arrastar já fazem. */
function vinhoDetalheHTML(v){
  const ativas=garrafasDe(v.id,true), bebidas=garrafasDe(v.id,false).filter(g=>g.estado==='consumida');
  const cl=castaLabel(v), jan=janelaBeber(v);
  const estagio=v.estagio_texto||(v.estagio_meses?`${v.estagio_meses} meses`:'');
  const idadeInfo=v.beber_de||v.beber_ate
    ? `${v.beber_de||'?'} – ${v.beber_ate||'?'}  ${janelaBadge(v,jan,true)}` : '';
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
          ${v.ano?`<div class="mhero-ab">${v.ano}</div>`:''}
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
      ${podeUsarIA()
        ? `<button class="btn prim" onclick="iaEscolher(${v.id})">🔎 Procurar informação</button>`
        : '<span class="note">A pesquisa por IA não está incluída no teu acesso.</span>'}
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
// Tamanho da GARRAFA (não do vinho): três formatos fixos, como o resto do
// vocabulário desta app — evita "75cl"/"0.75L"/"750ml" a designarem a mesma
// coisa de jeitos diferentes consoante quem escreveu.
const FORMATOS=['0,75 L','1,5 L','3 L'];
function renderPickerPosicoes(prefix,gid){
  const box=document.getElementById(`${prefix}-slotpick`);
  const locSel=document.getElementById(`${prefix}-local`);
  if(!box||!locSel)return;
  box.dataset.gid=String(gid||0);
  const localId=locSel.value?parseInt(locSel.value,10):0;
  const l=IDXL[localId];
  if(!l||!temLayoutLocal(l)){
    box.innerHTML='';
    // sem desenho, a prateleira volta a ser texto livre
    const pi=document.getElementById(`${prefix}-prat`),pb=document.getElementById(`${prefix}-pratbox`),lb=document.getElementById(`${prefix}-lugarlbl`);
    if(pi){pi.readOnly=false;pi.placeholder='Nível 3';}
    if(pb)pb.classList.remove('derivado');
    if(lb)lb.textContent='Lugar';
    return;
  }
  const prats=layoutLocal(l);
  const occ=ocupacaoLayout(localId,gid||0);
  const lugarAtual=lugarNumeroLayout(document.getElementById(`${prefix}-lugar`).value);
  // Com a numeração corrida a prateleira sai do número, e escrevê-la à mão
  // noutro campo só dava para os dois se contradizerem: aqui ela deixa de
  // se editar e passa a mostrar o que o lugar diz.
  const pratBox=document.getElementById(`${prefix}-pratbox`);
  const pratIn=document.getElementById(`${prefix}-prat`);
  if(pratIn){
    pratIn.readOnly=true;
    pratIn.value=nomeDaPosicao(localId,lugarAtual)||'';
    pratIn.placeholder='(pelo lugar)';
  }
  if(pratBox)pratBox.classList.add('derivado');
  const lbl=document.getElementById(`${prefix}-lugarlbl`);
  if(lbl)lbl.textContent=`Lugar (1 a ${lugaresLocal(l)})`;
  const livres=prats.reduce((s,p)=>{
    let n=0;
    for(let i=1;i<=p.capacidade;i++)if(!(occ[p.base+i]||[]).length)n++;
    return s+n;
  },0);
  box.innerHTML=`
    <div class="lpick">
      <div class="lpick-top">
        <div>
          <div class="msec">Posição no desenho</div>
          <div class="note">Escolhe um lugar livre na estante. Se ainda não souberes onde fica, deixa em branco e a garrafa aparece por posicionar.</div>
        </div>
        <div class="lpick-n">${livres} ${livres===1?'livre':'livres'}</div>
      </div>
      ${prateleirasDesc(prats).map(p=>`
        ${(()=>{const pp=Object.assign({},p,{ondulada:false,desvio:0});const info=prateleiraLayoutInfo(pp);const compacto=p.formato!=='fila';return `<div class="lprat">
          <div class="lprat-t">${esc(p.nome)} <span>${p.capacidade===1?`lugar ${p.base+1}`:`lugares ${p.base+1}–${p.base+p.capacidade}`}</span></div>
          ${estanteHTML(pp,info,info.slots.map(s=>{
            const lugar=s.lugar;
            const pos=` style="${slotGridStyle(s)}"`;
            const lista=occ[lugar]||[];
            const sel=lugarAtual===lugar;
            if(lista.length){
              const v=IDXV[(lista[0]||{}).vinho_id]||{nome:'?'};
              return `<button type="button" class="lpslot${compacto?' mini':''} ocup" disabled${pos} title="${esc(v.nome)} · ${esc(posicaoTxt(p.nome,lugar))}">${garrafaSVG(v,1)}<span>${lugar}</span></button>`;
            }
            return `<button type="button" class="lpslot${compacto?' mini':''}${sel?' on':''}"${pos} onclick="escolherPosicaoLayout('${prefix}',${lugar})" title="${esc(posicaoTxt(p.nome,lugar))}"><span>${lugar}</span></button>`;
          }).join(''),'est-pick')}
        </div>`;})()}
      `).join('')}
      <div class="lpick-foot">
        <button type="button" class="lnk" onclick="limparPosicaoLayout('${prefix}')">deixar por arrumar</button>
      </div>
    </div>`;
}
function pickerGid(prefix){
  return parseInt((((document.getElementById(`${prefix}-slotpick`)||{}).dataset||{}).gid)||'0',10)||0;
}
function escolherPosicaoLayout(prefix,lugar){
  document.getElementById(`${prefix}-lugar`).value=String(lugar);
  renderPickerPosicoes(prefix,pickerGid(prefix));
}
function limparPosicaoLayout(prefix){
  document.getElementById(`${prefix}-prat`).value='';
  document.getElementById(`${prefix}-lugar`).value='';
  renderPickerPosicoes(prefix,pickerGid(prefix));
}

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
  // O tamanho é um campo da GARRAFA, não do vinho — mas editar vinho a
  // vinho é onde as pessoas vão à procura dele, por isso aqui mostra-se o
  // formato de quem já está na garrafeira (a primeira ativa, ou 0,75 L se
  // não houver nenhuma) e gravar aplica-o a TODAS as garrafas ativas deste
  // vinho de uma vez. Para dar tamanhos diferentes à mesma referência
  // (uma normal e uma magnum), continua a ser a garrafa a garrafa, em
  // "Mover" na página do vinho.
  const formatoAtual=id?(garrafasDe(id,true)[0]||{}).formato||'0,75 L':'0,75 L';

  document.getElementById('modal-edit-in').innerHTML=`
    <div class="mtop"><h3>${id?'Editar vinho':'Novo vinho'}</h3>
      <button class="mx" onclick="fecharModal('modal-edit')">✕</button></div>

    <label>Nome</label>
    <input type="text" id="e-nome" value="${esc(o('nome'))}" placeholder="Quinta do Vallado Touriga Nacional">
    <div class="mrow">
      <div><label>Ano</label><input type="number" id="e-ano" inputmode="numeric" value="${esc(o('ano'))}" placeholder="2021"></div>
      <div><label>Produtor</label><input type="text" id="e-produtor" value="${esc(o('produtor'))}" placeholder="Quinta do Vallado"></div>
    </div>

    ${id?`<div class="mrow">
      <div><label>Formato da garrafa</label><select id="e-formato-edit">${FORMATOS.map(x=>
        `<option value="${esc(x)}"${formatoAtual===x?' selected':''}>${esc(x)}</option>`).join('')}</select></div>
    </div>
    <div class="note">Aplica-se a todas as garrafas deste vinho ainda na garrafeira.</div>`:''}

    ${id?'':podeUsarIA()?`<div class="aviso">Escreve o nome (e o ano, se souberes) e carrega em <b>Procurar informação</b>: a pesquisa preenche o resto — castas, região, tipo, nota do Vivino, preço médio e quando beber. Confirmas antes de gravar.</div>
      <button class="btn prim full" id="e-btn-ia" onclick="iaProcurarNovo()">🔎 Procurar informação</button>
      <div id="e-ia-estado"></div>`:'<div class="note">A pesquisa por IA não está incluída no teu acesso. Pede ao admin para te atribuir um modo com IA.</div>'}

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

    <label>Harmoniza com</label>
    <textarea id="e-harmonizacao" placeholder="Queijos curados, carnes grelhadas…">${esc(o('harmonizacao'))}</textarea>

    <label>As minhas notas</label>
    <textarea id="e-notas" placeholder="Onde comprei, para que ocasião guardei, o que achei…">${esc(o('notas'))}</textarea>

    ${id?'':`
      <div class="msec">Primeira garrafa</div>
      <div class="mrow">
        <div><label>Local</label><select id="e-local">${locOpts||'<option value="">(cria um local primeiro)</option>'}</select></div>
        <div><label>Quantas</label><input type="number" id="e-qtd" inputmode="numeric" value="1" min="1" max="60"></div>
      </div>
      <div id="e-slotpick"></div>
      <div class="mrow">
        <div><label>Prateleira</label><input type="text" id="e-prat" placeholder="Nível 3" oninput="renderPickerPosicoes('e',0)"></div>
        <div><label>Lugar</label><input type="text" id="e-lugar" placeholder="12" oninput="renderPickerPosicoes('e',0)"></div>
      </div>
      <div class="mrow">
        <div><label>Formato</label><select id="e-formato">${FORMATOS.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></div>
        <div><label>Preço de compra (€)</label><input type="text" id="e-preco-compra" inputmode="decimal" placeholder="15.90"></div>
      </div>
      <label>Comprada em</label>
      <input type="date" id="e-comprado">`}

    <div class="macoes">
      <button class="btn prim" id="e-guardar" onclick="guardarVinho(${id})">${id?'Guardar':'Adicionar à garrafeira'}</button>
      <button class="btn ghost" onclick="fecharModal('modal-edit')">Cancelar</button>
    </div>`;
  abrirModal('modal-edit');
  if(!id){
    const loc=document.getElementById('e-local');
    if(loc)loc.onchange=()=>renderPickerPosicoes('e',0);
    renderPickerPosicoes('e',0);
  }
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
    harmonizacao:g('e-harmonizacao'),
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
  if(!id&&!GA_ID){toast('Não há nenhuma garrafeira aberta',1);return;}
  if(f.ano!=null&&(f.ano<1900||f.ano>2100)){toast('Ano fora do razoável',1);return;}
  let primeiraGarrafa=null;
  if(!id){
    const localSel=document.getElementById('e-local');
    primeiraGarrafa={
      local_id:localSel&&localSel.value?parseInt(localSel.value,10):null,
      prateleira:document.getElementById('e-prat').value.trim(),
      lugar:document.getElementById('e-lugar').value.trim(),
      formato:document.getElementById('e-formato').value,
      preco_compra:num(document.getElementById('e-preco-compra').value),
      comprado_em:document.getElementById('e-comprado').value||null
    };
    // num local com desenho o nome da prateleira sai do número do lugar:
    // é o número que a pessoa escolhe, e escrevê-lo à mão noutro campo só
    // dava para os dois se contradizerem
    primeiraGarrafa.prateleira=nomeDaPosicao(primeiraGarrafa.local_id,primeiraGarrafa.lugar)||primeiraGarrafa.prateleira;
    const erroPos=validarPosicaoLayout(primeiraGarrafa.local_id,primeiraGarrafa.lugar,0);
    if(erroPos){toast(erroPos,1);return;}
  }
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
      const novoFormato=document.getElementById('e-formato-edit').value;
      const ativas=garrafasDe(id,true).filter(g=>g.formato!==novoFormato);
      if(ativas.length){
        await sbReq('PATCH',`garrafas?vinho_id=eq.${id}&estado=eq.na_garrafeira`,{formato:novoFormato});
        ativas.forEach(g=>g.formato=novoFormato);
      }
    }else{
      // O vinho nasce na garrafeira que está aberta. A policy confirma que
      // ela é minha; o trigger só serve de rede se isto faltar.
      const r=await sbReq('POST','vinhos',[Object.assign({garrafeira_id:GA_ID},f)],{'Prefer':'return=representation'});
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
      const base=Object.assign({vinho_id:vinhoId},primeiraGarrafa);
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
    <div id="g-slotpick"></div>
    <div class="mrow">
      <div id="g-pratbox"><label>Prateleira</label><input type="text" id="g-prat" value="${esc(g?g.prateleira:'')}" placeholder="Nível 3" oninput="renderPickerPosicoes('g',${gid||0})"></div>
      <div><label id="g-lugarlbl">Lugar</label><input type="text" id="g-lugar" value="${esc(g?g.lugar:'')}" placeholder="12" inputmode="numeric" oninput="renderPickerPosicoes('g',${gid||0})"></div>
    </div>
    <div class="mrow">
      <div><label>Formato</label><select id="g-formato">${FORMATOS.map(x=>
        `<option value="${esc(x)}"${(g?g.formato:'0,75 L')===x?' selected':''}>${esc(x)}</option>`).join('')}</select></div>
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
  const loc=document.getElementById('g-local');
  if(loc)loc.onchange=()=>renderPickerPosicoes('g',gid||0);
  renderPickerPosicoes('g',gid||0);
}
async function guardarGarrafa(gid,vinhoId){
  if(roGuard())return;
  const locSel=document.getElementById('g-local');
  const dados={
    local_id:locSel&&locSel.value?parseInt(locSel.value,10):null,
    prateleira:document.getElementById('g-prat').value.trim(),
    lugar:document.getElementById('g-lugar').value.trim(),
    formato:document.getElementById('g-formato').value,
    preco_compra:num(document.getElementById('g-preco').value),
    comprado_em:document.getElementById('g-comprado').value||null
  };
  dados.prateleira=nomeDaPosicao(dados.local_id,dados.lugar)||dados.prateleira;
  const erroPos=validarPosicaoLayout(dados.local_id,dados.lugar,gid);
  if(erroPos){toast(erroPos,1);return;}
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
function abrirSubstituirGarrafa(gid){
  if(roGuard())return;
  const g=db.garrafas.find(x=>x.id===gid&&naGarrafeira(x));if(!g)return;
  const atual=IDXV[g.vinho_id]||{nome:'?'};
  const opts=[...db.vinhos].sort((a,b)=>
    String(a.nome||'').localeCompare(String(b.nome||''),'pt',{numeric:true,sensitivity:'base'})||
    String(a.ano||'').localeCompare(String(b.ano||''),'pt',{numeric:true})
  ).map(v=>`<option value="${v.id}"${v.id===g.vinho_id?' selected':''}>${esc(v.nome)}${v.ano?` · ${esc(v.ano)}`:''}${v.regiao?` · ${esc(v.regiao)}`:''}</option>`).join('');
  document.getElementById('modal-substituir-in').innerHTML=`
    <div class="mtop"><div><h3>Substituir vinho</h3>
      <div class="note" style="margin-top:3px">${esc(atual.nome)} ${atual.ano||''} · ${esc(ondeEsta(g))}</div></div>
      <button class="mx" onclick="fecharModal('modal-substituir')">✕</button></div>
    <label>Novo vinho neste lugar</label>
    <select id="gs-vinho">${opts}</select>
    <div class="note">A garrafa fica no mesmo local, prateleira e lugar — só muda a referência do vinho.</div>
    <div class="macoes">
      <button class="btn prim" id="gs-btn" onclick="guardarSubstituirGarrafa(${gid})">Guardar</button>
      <button class="btn ghost" onclick="fecharModal('modal-substituir')">Cancelar</button>
    </div>`;
  abrirModal('modal-substituir');
}
async function guardarSubstituirGarrafa(gid){
  if(roGuard())return;
  const g=db.garrafas.find(x=>x.id===gid&&naGarrafeira(x));if(!g)return;
  const sel=document.getElementById('gs-vinho');
  const vinhoId=sel&&sel.value?parseInt(sel.value,10):0;
  if(!vinhoId){toast('Escolhe um vinho',1);return;}
  if(vinhoId===g.vinho_id){toast('Esta garrafa já está nesse vinho');return;}
  const btn=document.getElementById('gs-btn');
  btn.disabled=true;btn.textContent='A guardar…';
  try{
    await sbReq('PATCH',`garrafas?id=eq.${gid}`,{vinho_id:vinhoId});
    g.vinho_id=vinhoId;
    reindexar();fecharModal('modal-substituir');renderLista();refrescarVinhoAberto();
    if(tabAtiva==='locais')renderMapa();
    toast('Garrafa substituída ✓');
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    btn.disabled=false;btn.textContent='Guardar';
  }
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
   levanta um erro com uma mensagem que se possa mostrar a alguém.

   `motor` é o que se PEDE à função ('gratis'|'premium'), e não é o mesmo que
   o plano de quem pede: ela atende o premium só a quem a BD disser que o é.
   O browser consegue pedir MENOS do que tem, nunca mais. */
async function iaPedir(pedido,vinhoId,motor){
  motor=motor==='premium'?'premium':'gratis';
  await iaLog('pedido',{pedido,vinho_id:vinhoId||null,plano:planoIA(),motor});
  let r;
  try{
    r=await sbFetch(`${SB_URL}/functions/v1/vinho-info`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify(Object.assign({assincrono:true,vinhoId:vinhoId||null,plano:motor},pedido))
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
  if(!podeUsarIA()){toast('A pesquisa por IA não está incluída no teu acesso',1);return;}
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
      o modelo concentra-se nisso em vez de andar atrás de tudo. Já vêm marcados os campos vazios.
      ${temPremium()?'Procura-se com a <b>IA com pesquisa web</b>; no fim podes repetir sem pesquisa web e comparar as duas.':''}</div>

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
  const pedido={nome:v.nome,ano:v.ano,produtor:v.produtor,regiao:v.regiao};
  if(IA_ESC)pedido.campos=IA_ESC;
  // O pedido fica guardado tal e qual: a segunda volta tem de ser a MESMA
  // pergunta, senão não se está a comparar motores, está-se a comparar duas
  // perguntas diferentes.
  // O vinho fica marcado JÁ, e não só quando o resultado chega: se a primeira
  // volta falhar, o botão da segunda opinião precisa de saber de que vinho
  // estamos a falar — sem isto ia buscar o do resultado anterior.
  IA_PEDIDO=pedido;IA_VINHO=vinhoId;IA_RES=null;IA_RES2=null;IA_ERRO2='';
  IA_MOTOR=motorDoPlano();IA_MOTOR2='';
  iaMostrarEspera(v.nome+(v.ano?' '+v.ano:''),IA_MOTOR);
  try{
    iaMostrarResultado(await iaPedir(pedido,vinhoId,IA_MOTOR),vinhoId);
  }catch(e){iaMostrarErro(e.message);}
}

/* A SEGUNDA OPINIÃO: a mesma pergunta feita ao OUTRO motor, para se ver campo
   a campo em que é que eles diferem. Só faz sentido a quem é premium — é o
   único que tem os dois à mão. Se falhar, volta-se ao resultado que já se
   tinha com o erro por cima, em vez de o deitar fora (ele custou uma chamada
   na mesma). */
function motorOposto(m){return m==='premium'?'gratis':'premium';}
async function iaSegundaOpiniao(){
  if(!temPremium()||!IA_PEDIDO||!IA_VINHO)return;
  const v=IDXV[IA_VINHO]||{};
  const motor=motorOposto(IA_MOTOR);
  // A primeira volta pode ter falhado (chave sem quota, o modelo em baixo):
  // aí não há par nenhum para comparar e esta passa a ser A leitura, com o
  // ecrã de sempre.
  const semPrimeira=!IA_RES;
  iaMostrarEspera(v.nome+(v.ano?' '+v.ano:''),motor);
  try{
    const res=await iaPedir(IA_PEDIDO,IA_VINHO,motor);
    IA_ERRO2='';
    if(semPrimeira){IA_MOTOR=motor;iaMostrarResultado(res,IA_VINHO);return;}
    IA_RES2=res;IA_MOTOR2=motor;
  }catch(e){
    IA_RES2=null;IA_MOTOR2='';IA_ERRO2=e.message;
    if(semPrimeira){iaMostrarErro(e.message);return;}
  }
  iaMostrarResultado(IA_RES,IA_VINHO);
}
// Do formulário de "novo vinho": preenche os campos em vez de gravar.
async function iaProcurarNovo(motor){
  if(!podeUsarIA()){toast('A pesquisa por IA não está incluída no teu acesso',1);return;}
  const nome=document.getElementById('e-nome').value.trim();
  if(!nome){toast('Escreve primeiro o nome do vinho',1);document.getElementById('e-nome').focus();return;}
  const ano=inteiro(document.getElementById('e-ano').value);
  const btn=document.getElementById('e-btn-ia');
  const est=document.getElementById('e-ia-estado');
  /* Aqui não há ecrã de confirmação onde comparar as duas (o formulário é ele
     próprio a confirmação), por isso a segunda volta REESCREVE o que a
     primeira encheu — e só isso, ver `iaPreencherForm`. Por omissão vale o
     motor do PLANO; `motor` só vem preenchido pelo botão da segunda opinião. */
  const m=motor&&temPremium()?motor:motorDoPlano();
  const outro=motorOposto(m);
  if(!motor)_iaAuto=[];
  btn.disabled=true;btn.textContent='🔎 A procurar…';
  est.innerHTML=`<div class="note" style="margin-top:8px">A ${esc(rotuloMotor(m))} está a procurar na net. Pode levar até dois minutos — podes ir fazendo o resto.</div>`;
  const botaoOutro=!motor&&temPremium()
    ? `<button class="mini${outro==='premium'?' o':''}" style="margin-top:8px" onclick="iaProcurarNovo('${outro}')">✨ Tentar com a ${esc(rotuloMotor(outro))}</button>`:'';
  try{
    const res=await iaPedir({nome,ano,produtor:document.getElementById('e-produtor').value.trim()},null,m);
    iaPreencherForm(res,!!motor);
    est.innerHTML=`<div class="note" style="margin-top:8px;color:var(--vd)">✓ Preenchido pela ${esc(rotuloMotor(m))}${res.fontes&&res.fontes.length?' ('+res.fontes.length+' fontes)':''}. Confere antes de gravar.</div>`+botaoOutro;
  }catch(e){
    // Mesma ideia do `iaMostrarErro`: o motor do plano falhou, mas quem é
    // premium tem o outro para onde ir.
    est.innerHTML=`<div class="erro">${esc(e.message)}</div>`+botaoOutro;
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

function iaMostrarEspera(titulo,motor){
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><h3>🔎 A procurar</h3><button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    <div class="note" style="margin-top:6px">${esc(titulo)} · ${esc(rotuloMotor(motor))}</div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:20px">
      <div class="gl-spin" style="border-color:var(--vhp);border-top-color:var(--vh);width:22px;height:22px"></div>
      <div class="note">A pesquisar na net e a ler o que se encontra. Pode levar até dois minutos.</div>
    </div>
    <div class="aviso">Podes fechar esta janela — a procura continua no servidor. Só não fica gravada sem tu confirmares.</div>`;
  abrirModal('modal-ia');
}
function iaMostrarErro(msg){
  /* Se o motor do plano falhar, quem é premium ainda tem o outro à mão — e
     foi o que valeu quando a chave do modo sem pesquisa web ficou sem quota. O botão desaparece
     depois de o segundo motor também ter falhado, para não convidar a
     insistir no mesmo. */
  const outro=temPremium()&&IA_PEDIDO&&IA_VINHO&&!IA_RES2&&!IA_ERRO2;
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><h3>Não deu</h3><button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    <div class="erro">${esc(msg)}</div>
    <div class="macoes">${outro?`<button class="btn prim" onclick="iaSegundaOpiniao()">✨ Tentar com a ${esc(rotuloMotor(motorOposto(IA_MOTOR)))}</button>`:''}
      <button class="btn ghost" onclick="fecharModal('modal-ia')">Fechar</button></div>`;
  abrirModal('modal-ia');
}

/* `IA_RES` é a primeira leitura e `IA_MOTOR` o motor que a produziu — o do
   PLANO de quem procura (premium a quem o tem, modo sem pesquisa web aos outros). `IA_RES2`
   é a segunda opinião, o outro motor, e só existe se alguém premium a pedir.

   Com uma leitura só, cada campo é uma CAIXA, como sempre foi. Com duas, os
   campos em que elas discordam viram botões de RÁDIO — manter / uma / outra —
   porque com duas propostas em cima da mesa "marcado" já não dizia qual delas
   entrava. Os campos em que as duas concordam ficam caixa e dizem-no: pedir
   uma escolha onde não há escolha nenhuma era encher o ecrã de decisões
   falsas. */
let IA_RES=null, IA_VINHO=null, IA_RES2=null, IA_PEDIDO=null, IA_ERRO2='';
let IA_MOTOR='gratis', IA_MOTOR2='';

function iaTxt(c,res){
  const v=res?res[c.k]:null;
  if(v==null||v===''||(Array.isArray(v)&&!v.length))return '';
  return c.fmt?c.fmt(v):String(v);
}
function iaMostrarResultado(res,vinhoId){
  IA_RES=res||{};IA_VINHO=vinhoId;
  const v=IDXV[vinhoId]||{};
  const cmp=!!IA_RES2;
  // Qual das duas é a premium muda com o plano de quem procura: é ela que
  // leva o dourado, aqui como em todo o resto da app.
  const rot1=rotuloMotor(IA_MOTOR), rot2=rotuloMotor(IA_MOTOR2);
  // `.ia-op.pr` é a opção dourada na lista; `.mini.o` é o botão dourado da
  // barra de atalhos. São dois sítios com a mesma ideia e classes diferentes.
  const cls1=IA_MOTOR==='premium'?' pr':'', cls2=IA_MOTOR2==='premium'?' pr':'';
  const mini1=IA_MOTOR==='premium'?' o':'', mini2=IA_MOTOR2==='premium'?' o':'';
  const atual=k=>k==='castas'?(v.castas||[]).join(', '):(v[k]==null?'':String(v[k]));

  const linhas=IA_CAMPOS.map(c=>{
    const ant=atual(c.k), g=iaTxt(c,IA_RES), p=cmp?iaTxt(c,IA_RES2):'';
    const novoG=g&&chave(g)!==chave(ant), novoP=p&&chave(p)!==chave(ant);
    if(!novoG&&!novoP)return '';                              // já lá está igual
    // Marcado por omissão só o que está VAZIO. Substituir o que alguém
    // escreveu à mão por uma leitura automática tem de ser um clique
    // consciente, não o comportamento normal.
    const vazio=!ant;
    const caixa=(txt,nota)=>`<div class="ia-linha">
      <input type="checkbox" id="ia-${c.k}"${vazio?' checked':''}>
      <label for="ia-${c.k}" class="ia-campo" style="margin:0;text-transform:none;letter-spacing:0;font-weight:400;color:var(--tx)">
        <b>${esc(c.rot)}${nota||''}</b>
        ${ant?`<span class="ia-antes">${esc(ant)}</span> → `:''}${esc(txt)}
      </label></div>`;

    if(!cmp)return caixa(g);
    if(g&&p&&chave(g)===chave(p))return caixa(g,' <i class="ia-igual">as duas concordam</i>');

    // Discordam (ou uma delas não trouxe nada): escolhe-se qual entra. O
    // "manter" está sempre lá — sem ele, um campo vazio com duas propostas
    // obrigava a aceitar uma delas, que é o contrário de confirmar.
    /* Num campo vazio ganha por omissão a leitura PREMIUM — é a cara, é a que
       se pediu de propósito — e a outra só entra se a premium não trouxe nada.
       Qual das duas é a premium depende do plano de quem procura, por isso não
       se pode fixar aqui "a segunda". */
    const rPrem=IA_MOTOR==='premium'?'r1':'r2', tPrem=IA_MOTOR==='premium'?g:p;
    const rOutra=rPrem==='r1'?'r2':'r1',        tOutra=rPrem==='r1'?p:g;
    const def=!vazio?'atual':(tPrem?rPrem:(tOutra?rOutra:'atual'));
    const op=(val,rot,txt,cls)=>`<label class="ia-op${cls||''}">
      <input type="radio" name="iap-${c.k}" value="${val}"${def===val?' checked':''}>
      <span><i>${esc(rot)}</i>${esc(txt)}</span></label>`;
    return `<div class="ia-cmp"><b class="ia-cmp-t">${esc(c.rot)}</b>
      ${op('atual','manter',ant||'(vazio)',' at')}
      ${g?op('r1',rot1,g,cls1):''}
      ${p?op('r2',rot2,p,cls2):''}</div>`;
  }).filter(Boolean).join('');

  const fontesDe=(r,rot)=>r&&r.fontes&&r.fontes.length
    ? `<div class="ia-fontes">Fontes${cmp?' ('+rot+')':''}: ${r.fontes.map(f=>
        `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}</div>`:'';
  const semNet=IA_RES.pesquisa===false||(IA_RES2&&IA_RES2.pesquisa===false);

  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><div><h3>${cmp?esc(rot1)+' vs '+esc(rot2):'O que se encontrou'}</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome||'')} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>

    ${IA_ERRO2?`<div class="erro">A segunda opinião não deu: ${esc(IA_ERRO2)}. Fica o que a ${esc(rot1)} trouxe.</div>`:''}
    ${!cmp&&temPremium()&&linhas?`<div class="ia-prbar">
      <span>Isto foi a <b>${esc(rot1)}</b>. Queres ver o que a ${esc(rotuloMotor(motorOposto(IA_MOTOR)))} diz ao lado?</span>
      <button class="mini o" onclick="iaSegundaOpiniao()">✨ Comparar</button></div>`:''}

    ${linhas?`<div class="note" style="margin-top:10px">${cmp
        ? 'Cada campo mostra o que cada motor trouxe — escolhe o que fica. Os campos que já tinham valor vêm em <b>manter</b>.'
        : 'Só entra o que ficar marcado. Já vêm marcados os campos que estavam <b>vazios</b>; para trocar o que já lá estava, marca à mão.'}</div>
      ${cmp?`<div class="ia-escbar">
        <button class="mini${mini1}" onclick="iaTudoDe('r1')">Tudo da ${esc(rot1)}</button>
        <button class="mini${mini2}" onclick="iaTudoDe('r2')">Tudo da ${esc(rot2)}</button>
        <button class="mini" onclick="iaTudoDe('atual')">Manter tudo</button></div>`:''}
      <div style="margin-top:8px">${linhas}</div>
      <div class="macoes">
        <button class="btn prim" id="ia-btn" onclick="iaAplicar()">Guardar o que ${cmp?'escolhi':'está marcado'}</button>
        ${cmp?'':'<button class="btn ghost" onclick="iaTodos(true)">Marcar tudo</button>'}
        <button class="btn ghost" onclick="fecharModal('modal-ia')">Cancelar</button>
      </div>`
    :`<div class="note" style="margin-top:14px">A procura não trouxe nada de novo — o que está na ficha já bate certo com o que se encontrou.</div>
      <div class="macoes">${!cmp&&temPremium()?`<button class="btn ghost" onclick="iaSegundaOpiniao()">✨ Tentar com a ${esc(rotuloMotor(motorOposto(IA_MOTOR)))}</button>`:''}
        <button class="btn ghost" onclick="fecharModal('modal-ia')">Fechar</button></div>`}

    ${fontesDe(IA_RES,rot1)}${cmp?fontesDe(IA_RES2,rot2):''}
    <div class="ia-fontes"><i>${semNet
      ? '⚠️ Isto saiu da memória do modelo, sem pesquisa na net — confere tudo antes de aceitar.'
      : 'Leitura automática de páginas da net. Vale como ponto de partida, não como certeza.'}</i></div>`;
  abrirModal('modal-ia');
}
function iaTodos(marcar){
  IA_CAMPOS.forEach(c=>{const e=document.getElementById('ia-'+c.k);if(e)e.checked=marcar;});
}
/* Pôr a ficha inteira numa das leituras de uma vez. É isto que torna a
   comparação útil de verdade: vê-se a ficha toda de um lado, depois a do
   outro, em vez de a montar campo a campo às cegas. As caixas são as linhas
   em que as duas concordam — entram com qualquer uma e saem todas no
   "manter". */
function iaTudoDe(qual){
  IA_CAMPOS.forEach(c=>{
    const cx=document.getElementById('ia-'+c.k);
    if(cx)cx.checked=qual!=='atual';
    const r=document.querySelector(`input[name="iap-${c.k}"][value="${qual}"]`);
    if(r)r.checked=true;
  });
}

async function iaAplicar(){
  if(roGuard())return;
  const patch={},v=IDXV[IA_VINHO];
  if(!v)return;
  let castasNovas=null;
  const usados=[];                 // que leituras é que acabaram por entrar
  IA_CAMPOS.forEach(c=>{
    let res;
    const r=document.querySelector(`input[name="iap-${c.k}"]:checked`);
    if(r){                         // linha de escolha entre as duas leituras
      if(r.value==='atual')return;
      res=r.value==='r2'?IA_RES2:IA_RES;
    }else{                         // caixa: leitura única, ou as duas de acordo
      const e=document.getElementById('ia-'+c.k);
      if(!e||!e.checked)return;
      res=IA_RES;
    }
    if(!res)return;
    if(!usados.includes(res))usados.push(res);
    const val=res[c.k];
    if(c.k==='castas'){castasNovas=Array.isArray(val)?val:String(val).split(',').map(s=>s.trim()).filter(Boolean);return;}
    patch[c.k]=val;
  });
  if(!Object.keys(patch).length&&!castasNovas){toast('Não escolheste nada');return;}

  // Carimbo da procura: fica sempre, mesmo que só se tenha aceitado um
  // campo. É o que deixa saber, daqui a um ano, de onde veio aquilo. Com
  // campos aceites das duas leituras ficam os dois modelos — `iaUltimaProcura`
  // só conta esta coluna quando começa por "gemini", e ambos começam.
  patch.ai_atualizado_em=new Date().toISOString();
  const modelos=[...new Set(usados.map(r=>r.modelo).filter(Boolean))];
  if(modelos.length)patch.ai_modelo=modelos.join(' + ');
  const fontes=[];
  usados.forEach(r=>(r.fontes||[]).forEach(f=>{if(!fontes.some(x=>x.url===f.url))fontes.push(f);}));
  if(fontes.length)patch.ai_fontes=fontes.slice(0,8);

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
    if(btn){btn.disabled=false;btn.textContent='Guardar o que '+(IA_RES2?'escolhi':'está marcado');}
  }
}

// No formulário de vinho novo não há nada gravado para comparar: escreve-se
// só nos campos que estão VAZIOS, para não apagar o que a pessoa acabou de
// escrever à mão enquanto a procura corria.
// `_iaAuto` são os campos que a procura encheu sozinha. É o que deixa a
// segunda volta (premium) reescrever o que a PRIMEIRA pôs sem tocar no que a
// pessoa escreveu à mão entretanto.
let _iaAuto=[];
function iaPreencherForm(res,substituir){
  const por=(id,val)=>{
    const e=document.getElementById(id);
    if(!e||val==null||val===''||(Array.isArray(val)&&!val.length))return;
    if(e.value.trim()&&!(substituir&&_iaAuto.includes(id)))return;
    const txt=Array.isArray(val)?val.join(', '):String(val);
    if(e.tagName==='SELECT'&&![...e.options].some(o=>o.value===txt))return;
    e.value=txt;
    if(!_iaAuto.includes(id))_iaAuto.push(id);
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
  por('e-imagem',res.imagem_url);por('e-harmonizacao',res.harmonizacao);
  // O resumo e as notas de prova só entram quando o vinho for gravado (o
  // formulário não tem campos para eles) — ficam aqui à espera disso.
  _iaExtraNovo={
    notas_prova:res.notas_prova||'',
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
    // A migração das garrafeiras (db/migracao-garrafeiras.sql) é a única
    // que a app não consegue contornar sozinha — sem ela não sabe de quem
    // são as garrafas, e adivinhar era mostrar as de toda a gente a toda a
    // gente. Vale a pena dizer isto por palavras em vez de deixar um
    // "erro a carregar: relation does not exist".
    toast(/garrafeiras|does not exist|relation/i.test(e.message)
      ?'Falta correr a migração db/migracao-garrafeiras.sql no Supabase.'
      :'Erro a carregar: '+e.message,1);
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
  if(papel)papel.textContent=(isAdmin()
    ?'És o admin da app — mandas em quem tem acesso e em quem pode ter garrafeira. '
    :(souEditor()?'Podes acrescentar, mover e dar saída a garrafas na tua garrafeira. '
                 :'Podes ver e procurar, mas não editar. '))
    +(garrafeiraAtiva()&&!souDonoDaGarrafeira()
      ?`Neste momento estás a ver a garrafeira de ${donoGarrafeira()} — aí só podes ver.`:'');
  const sobre=document.getElementById('sobre-box');
  if(sobre)sobre.innerHTML=`${nomeGarrafeira()?'<b>'+esc(nomeGarrafeira())+'</b>: ':''}${db.vinhos.length} vinhos · ${db.garrafas.length} garrafas (${db.garrafas.filter(naGarrafeira).length} na garrafeira) · ${db.locais.length} locais. ${db.castas.length} castas (a lista das castas é comum a toda a gente).<br>
    Dados e login no Supabase, schema <code>garrafeira</code>. Admin atual: <b>${esc(ADMIN_EMAIL)}</b>.`;
  renderCfgGarrafeira();
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
    const lay=resumoLayoutLocal(l);
    const meta=[l.descricao,lay].filter(Boolean).join(' — ');
    return `<div class="ua-row">
      <span class="pip" style="width:11px;height:11px;border-radius:50%;background:${esc(l.cor||'#7b1f3d')};flex-shrink:0"></span>
      <span class="em"><b>${esc(l.nome)}</b>${meta?` — ${esc(meta)}`:''}</span>
      <span class="tagme">${n}</span>
      <button class="jdel" style="color:var(--mu)" title="Editar" onclick="editarLocal(${l.id})">✏️</button>
      <button class="jdel" title="Apagar" onclick="apagarLocal(${l.id})">✕</button>
    </div>`;
  }).join('');
}
let LOC_LAYOUT_EDIT=[];
function layoutPadraoEditor(){
  return [{nome:'Nível 1',capacidade:6,formato:'fila',mais_em:'cima'},{nome:'Nível 2',capacidade:6,formato:'fila',mais_em:'cima'}];
}
/* O desenho das prateleiras, uma por linha: o nome (que se edita no
   sítio, sem caixa à volta — é um título, não um formulário), e por baixo
   o FORMATO e os LUGARES. O formato é um botão com os pontinhos do
   desenho atual e abre uma folha com as três opções ilustradas
   (`abrirFormatoPrat`) — um <select> não mostra desenhos, e aqui a
   diferença entre os três é o desenho. O "lugar a mais" dos sobrepostos
   ímpares só aparece quando existe. */
function renderLocalLayoutEditor(){
  const box=document.getElementById('loc-layout-box');
  const chk=document.getElementById('loc-tem-layout');
  if(!box||!chk)return;
  box.style.display=chk.checked?'':'none';
  if(!chk.checked)return;
  if(!LOC_LAYOUT_EDIT.length)LOC_LAYOUT_EDIT=layoutPadraoEditor();
  const caret='<svg class="ll-caret" viewBox="0 0 12 20" aria-hidden="true"><path d="M2 7l4-4 4 4M2 13l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Só nos sobrepostos de capacidade ímpar: onde fica o lugar a mais.
  const oddSel=(i,p)=>{
    const cap=Math.max(1,Math.min(240,inteiro((p&&p.capacidade))||0));
    if(normalizarFormatoPrateleira(p.formato)!=='sobrepostos'||!(cap%2))return '';
    const cur=normalizarSobrepostosMaisEm(p.mais_em);
    return `<div class="ll-odd"><span>Lugar a mais</span>
      <div class="segbtns">${MAIS_EM.map(([id,n])=>`<button type="button" class="segbtn${cur===id?' on':''}" onclick="locSetPratMaisEm(${i},'${id}')">${n}</button>`).join('')}</div>
    </div>`;
  };
  /* A MARCA DE ENCAIXE — o que restou do ziguezague. Uma prateleira
     encaixada assenta na de baixo, desencontrada, e desenha-se com a
     tábua em onda; é só isso, não muda os lugares nem a contagem. A
     primeira prateleira não a tem: não há nada por baixo dela. */
  const encSel=(i,p)=>i===0?'':`<label class="ll-enc"><input type="checkbox"${p.encaixe?' checked':''}
      onchange="locSetPratEncaixe(${i},this.checked)"><span>Encaixa na de baixo <i>(ziguezague)</i></span></label>`;
  const uma=LOC_LAYOUT_EDIT.length<=1;
  box.innerHTML=`
    <div class="note">A app desenha este local como estante: uma prateleira por linha, o Nível 1 em baixo. Os lugares são numerados de seguida ao longo do móvel — se o primeiro nível tem 4 lugares, o segundo começa no 5.</div>
    <div class="ll-lista">${LOC_LAYOUT_EDIT.map((p,i)=>`
      <div class="ll-row">
        <div class="ll-head">
          <input type="text" class="ll-nome" value="${esc(p.nome)}" oninput="locSetPratNome(${i},this.value)" placeholder="Nível ${i+1}" aria-label="Nome da prateleira">
          <button type="button" class="jdel ll-del" title="Remover prateleira" onclick="locRemPrat(${i})"${uma?' disabled':''}>✕</button>
        </div>
        <div class="ll-fields">
          <div><label>Formato</label>
            <button type="button" class="ll-fmt" onclick="abrirFormatoPrat(${i})" title="${esc(formatoPrateleiraNome(p.formato))}" aria-label="Formato: ${esc(formatoPrateleiraNome(p.formato))}">${prateleiraPreviewHTML(p)}${caret}</button></div>
          <div><label>Lugares</label>
            <input type="number" inputmode="numeric" min="1" max="240" value="${esc(p.capacidade)}" oninput="locSetPratCap(${i},this.value)" onchange="locCapMudou(${i})"></div>
        </div>
        ${oddSel(i,p)}${encSel(i,p)}
      </div>`).join('')}</div>
    <button type="button" class="btn ghost ll-add" onclick="locAddPrat()">+ Adicionar prateleira</button>`;
}
const FORMATOS_PRAT_DESC={fila:'Uma fila, lado a lado',sobrepostos:'Duas filas, uma sobre a outra'};
function abrirFormatoPrat(i){
  const p=LOC_LAYOUT_EDIT[i];if(!p)return;
  const atual=normalizarFormatoPrateleira(p.formato);
  document.getElementById('modal-formato-in').innerHTML=`
    <div class="mtop"><h3>Formato da prateleira</h3>
      <button class="mx" onclick="fecharModal('modal-formato')">✕</button></div>
    <div class="fmt-lista">${FORMATOS_PRATELEIRA.map(([id,n])=>`
      <button type="button" class="fmt-opt${id===atual?' on':''}" onclick="locEscolherFormato(${i},'${id}')">
        ${prateleiraPreviewHTML({formato:id,capacidade:5,mais_em:'cima'})}
        <span class="fmt-tx"><b>${n}</b><i>${FORMATOS_PRAT_DESC[id]}</i></span>
        <span class="fmt-ok">✓</span>
      </button>`).join('')}</div>`;
  abrirModal('modal-formato');
}
function locEscolherFormato(i,v){
  fecharModal('modal-formato');
  locSetPratFormato(i,v);
}
function locSetPratNome(i,v){
  if(LOC_LAYOUT_EDIT[i])LOC_LAYOUT_EDIT[i].nome=v;
}
function locSetPratCap(i,v){
  if(LOC_LAYOUT_EDIT[i])LOC_LAYOUT_EDIT[i].capacidade=v;
}
// Só redesenha quando a paridade importa (sobrepostos): redesenhar a cada
// número escrito tirava o foco da caixa a meio de escrever "12".
function locCapMudou(i){
  const p=LOC_LAYOUT_EDIT[i];
  if(p&&normalizarFormatoPrateleira(p.formato)==='sobrepostos')renderLocalLayoutEditor();
}
function locSetPratFormato(i,v){
  if(LOC_LAYOUT_EDIT[i]){
    LOC_LAYOUT_EDIT[i].formato=normalizarFormatoPrateleira(v);
    LOC_LAYOUT_EDIT[i].mais_em=normalizarSobrepostosMaisEm(LOC_LAYOUT_EDIT[i].mais_em);
  }
  renderLocalLayoutEditor();
}
function locSetPratEncaixe(i,v){
  if(LOC_LAYOUT_EDIT[i])LOC_LAYOUT_EDIT[i].encaixe=!!v;
  renderLocalLayoutEditor();
}
function locSetPratMaisEm(i,v){
  if(LOC_LAYOUT_EDIT[i])LOC_LAYOUT_EDIT[i].mais_em=normalizarSobrepostosMaisEm(v);
  renderLocalLayoutEditor();
}
// A prateleira nova copia a anterior (formato e lugares): numa estante a
// sério os níveis são quase sempre iguais uns aos outros.
function locAddPrat(){
  const ult=LOC_LAYOUT_EDIT[LOC_LAYOUT_EDIT.length-1]||{capacidade:6,formato:'fila',mais_em:'cima'};
  LOC_LAYOUT_EDIT.push({nome:`Nível ${LOC_LAYOUT_EDIT.length+1}`,capacidade:ult.capacidade,
    formato:ult.formato,mais_em:ult.mais_em,encaixe:!!ult.encaixe});
  renderLocalLayoutEditor();
}
function locRemPrat(i){
  if(LOC_LAYOUT_EDIT.length<=1)return;
  LOC_LAYOUT_EDIT.splice(i,1);
  renderLocalLayoutEditor();
}
function lerLayoutLocalModal(){
  if(!TEM_LOCAL_LAYOUT)return null;
  const chk=document.getElementById('loc-tem-layout');
  if(!chk||!chk.checked)return {prateleiras:[]};
  const prateleiras=LOC_LAYOUT_EDIT.map((p,i)=>{
    const nome=String((p&&p.nome)||'').trim()||`Nível ${i+1}`;
    const capacidade=Math.max(1,Math.min(240,inteiro((p&&p.capacidade))||0));
    const formato=normalizarFormatoPrateleira(p&&p.formato);
    const mais_em=normalizarSobrepostosMaisEm(p&&p.mais_em);
    // `mais_em` só se guarda onde conta (sobrepostos de capacidade ímpar),
    // e `encaixe` só onde é verdade — um layout que não os precise fica
    // sem eles em vez de os levar a falso por todo o lado
    const enc=!!(p&&p.encaixe)&&i>0;
    return capacidade?Object.assign({nome,capacidade,formato},
      formato==='sobrepostos'&&capacidade%2?{mais_em}:{}, enc?{encaixe:true}:{}) : null;
  }).filter(Boolean);
  if(!prateleiras.length)throw new Error('Cria pelo menos uma prateleira para ligar o desenho.');
  const vistos=new Set();
  for(const p of prateleiras){
    const k=chave(p.nome);
    if(vistos.has(k))throw new Error('Cada prateleira precisa de um nome diferente.');
    vistos.add(k);
  }
  return {prateleiras};
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
  LOC_LAYOUT_EDIT=layoutLocal(l);
  document.getElementById('modal-local-in').innerHTML=`
    <div class="mtop"><h3>${l?'Editar local':'Novo local'}</h3>
      <button class="mx" onclick="fecharModal('modal-local')">✕</button></div>
    <label>Nome</label>
    <input type="text" id="loc-nome" value="${esc(l?l.nome:'')}" placeholder="Frigorífico da cozinha">
    <label>Descrição (opcional)</label>
    <input type="text" id="loc-desc" value="${esc(l?l.descricao:'')}" placeholder="Níveis 1 a 14">
    ${TEM_LOCAL_LAYOUT?`<label class="chk ll-toggle"><input type="checkbox" id="loc-tem-layout" ${temLayoutLocal(l)?'checked':''} onchange="renderLocalLayoutEditor()">Desenhar este local como estante</label>
    <div id="loc-layout-box"></div>`:`<div class="note" style="margin-top:12px">O desenho das prateleiras fica disponível depois de correres a migração 10 da base de dados.</div>`}
    <div class="macoes">
      <button class="btn prim" id="loc-btn" onclick="guardarLocalModal(${l?l.id:0})">Guardar</button>
      <button class="btn ghost" onclick="fecharModal('modal-local')">Cancelar</button>
    </div>`;
  abrirModal('modal-local');
  renderLocalLayoutEditor();
}
async function guardarLocalModal(id){
  const nome=document.getElementById('loc-nome').value.trim();
  if(!nome){toast('O nome é obrigatório',1);return;}
  const dados={nome,descricao:document.getElementById('loc-desc').value.trim()};
  try{
    const layout=lerLayoutLocalModal();
    if(layout)dados.layout=layout;
  }catch(e){toast(e.message,1);return;}
  const btn=document.getElementById('loc-btn');
  btn.disabled=true;btn.textContent='A guardar…';
  try{
    if(id){
      await sbReq('PATCH',`locais?id=eq.${id}`,dados);
      Object.assign(IDXL[id],dados);
    }else{
      // `garrafeira_id` explícito: um local não tem por onde o adivinhar
      // (ao contrário da garrafa, que o herda do vinho por trigger).
      const r=await sbReq('POST','locais',[Object.assign({garrafeira_id:GA_ID,ordem:db.locais.length+1},dados)],{'Prefer':'return=representation'});
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

/* ── GARRAFEIRAS (a minha, e as que me emprestaram) ────────────────
   O sítio onde se troca de garrafeira e onde o dono decide quem mais a vê.
   Vive em Definições e NÃO leva `.ro-hide`: numa garrafeira emprestada o
   modo de leitura liga-se, e se este cartão desaparecesse com ele não
   havia caminho de volta à própria — ficava-se preso na do outro. */
function renderCfgGarrafeira(){
  const box=document.getElementById('cfg-garrafeira');
  if(!box)return;
  const g=garrafeiraAtiva();

  if(!g){
    box.innerHTML=`<div class="note" style="padding:6px 0">${souEditor()
      ? 'Ainda não tens garrafeira. Recarrega a página — ela é criada sozinha à entrada.'
      : 'Ainda não tens garrafeira própria, e ninguém te emprestou a dele.<br>'+
        'Pede ao admin para te marcar como <b>editor</b> (é isso que dá direito a garrafeira própria), '+
        'ou pede a um amigo que te partilhe a dele.'}</div>`;
    return;
  }

  const minha=souDonoDaGarrafeira(g);
  // A navegação só aparece quando há escolha — com uma garrafeira só,
  // setas não fazem nada.
  const idxAtivo=Math.max(0,GA_LISTA.findIndex(x=>x.id===GA_ID));
  const ant=GA_LISTA[(idxAtivo-1+GA_LISTA.length)%GA_LISTA.length];
  const seg=GA_LISTA[(idxAtivo+1)%GA_LISTA.length];
  const rot=x=>`${esc(x.nome)}${souDonoDaGarrafeira(x)?'':' — de '+esc(x.dono)}`;

  box.innerHTML=`
    ${GA_LISTA.length>1?`
      <label>A ver agora</label>
      <div class="ga-nav">
        <button type="button" class="ga-nav-btn" title="Anterior: ${rot(ant)}" onclick="trocarGarrafeiraDelta(-1)">‹</button>
        <div class="ga-nav-now"><b>${rot(g)}</b></div>
        <button type="button" class="ga-nav-btn" title="Seguinte: ${rot(seg)}" onclick="trocarGarrafeiraDelta(1)">›</button>
      </div>`
    :`<div class="ua-row"><span class="em"><b>${esc(g.nome)}</b></span>
        <span class="tagme">${minha?'tua':'de '+esc(g.dono)}</span></div>`}

    ${minha?`
      <div class="minha-only">
        <label>Nome da garrafeira</label>
        <div class="linha-add">
          <input type="text" id="ga-nome" value="${esc(g.nome)}" placeholder="Garrafeira do Barrona">
          <button class="btn ghost" onclick="renomearGarrafeira()">Guardar</button>
        </div>
        <div class="note" id="ga-nome-status"></div>

        ${isAdmin()?'':`
        <h4 style="margin-top:18px">Permissões ao admin</h4>
        <div class="note">O admin da app trata de quem entra — nas tuas garrafas só entra se tu
          deixares. Por defeito não vê nada. Isto vale para <b>quem for admin de cada vez</b>: se a
          app passar a outra pessoa, volta sozinho a "Nenhuma" e tens de decidir outra vez.</div>
        <select id="ga-admin" onchange="guardarAcessoAdmin(this.value)">
          <option value="nenhuma"${g.admin_acesso==='nenhuma'?' selected':''}>Nenhuma — nem vê a garrafeira</option>
          <option value="leitura"${g.admin_acesso==='leitura'?' selected':''}>Só leitura — vê, não mexe</option>
          <option value="edicao"${g.admin_acesso==='edicao'?' selected':''}>Leitura e edição — vê e mexe</option>
        </select>
        <div class="note" id="ga-admin-status"></div>`}

        <h4 style="margin-top:18px">Permissões de leitura a outros</h4>
        <div class="note">Quem puseres aqui vê as tuas garrafas mas <b>não lhes mexe</b> — nem
          acrescenta, nem consome, nem apaga. Tem de já ter acesso à app (é o admin que aprova isso).</div>
        <div id="cfg-partilhas"></div>
        <div class="linha-add">
          <input type="email" id="ga-partilhar" placeholder="email@exemplo.com">
          <button class="btn prim" onclick="partilharGarrafeira()">Dar acesso</button>
        </div>
        <div class="note" id="ga-partilhar-status"></div>

        <h4 style="margin-top:18px">Passar a garrafeira</h4>
        <div class="note">Passa estas garrafas para a conta de outra pessoa — as garrafas, os locais
          e o histórico vão todos com ela. Deixas de as ver (a não ser que ela te dê acesso de volta).
          É diferente de "passar a app": isso é quem manda em quem entra, isto é de quem são as garrafas.</div>
        <div class="linha-add">
          <input type="email" id="ga-passar" placeholder="email@exemplo.com">
          <button class="btn danger" onclick="passarGarrafeira()">Passar</button>
        </div>
        <div class="note" id="ga-passar-status"></div>

        <h4 style="margin-top:18px">Outra garrafeira</h4>
        <div class="note">Uma segunda garrafeira tua — a da casa de férias, ou a que estás a guardar
          para alguém. Trocas entre elas aqui em cima.</div>
        <div class="linha-add">
          <input type="text" id="ga-nova" placeholder="Garrafeira da praia">
          <button class="btn ghost" onclick="criarGarrafeira()">+ Criar</button>
        </div>
        <div class="note" id="ga-nova-status"></div>
      </div>`
    :`<div class="aviso" style="margin-top:10px">${souAdminConvidado(g)
        ? (acessoAdmin(g)==='edicao'
          ? `🔧 <b>${esc(g.dono)}</b> deu-te acesso de <b>leitura e edição</b> a esta garrafeira. O que mexeres aqui mexe nas garrafas dele.`
          : `👀 <b>${esc(g.dono)}</b> deu-te acesso de <b>leitura</b> a esta garrafeira. Vês e procuras, não mexes.`)
        : `👀 Estás a ver a garrafeira de <b>${esc(g.dono)}</b>.
           Aqui só podes ver e procurar — as garrafas são dele.`}</div>
      ${souAdminConvidado(g)
        ? `<div class="note">Foi ele que to deu nas Definições dele, e é lá que to tira.</div>`
        : `<button class="btn ghost" onclick="devolverGarrafeira()">Deixar de ver esta garrafeira</button>`}`}`;

  if(minha)renderPartilhas();
}

/* O dono escolhe o que o admin da app pode fazer aqui dentro. É um UPDATE à
   linha da garrafeira e não uma partilha: as partilhas são só de leitura, e
   esta é a única porta por onde alguém que não é dono pode vir a escrever. */
async function guardarAcessoAdmin(valor){
  const st=document.getElementById('ga-admin-status');
  const g=garrafeiraAtiva();
  if(!g)return;
  const antes=g.admin_acesso;
  st.style.color='var(--mu)';st.textContent='A guardar…';
  try{
    await sbReq('PATCH',`garrafeiras?id=eq.${g.id}`,{admin_acesso:valor});
    g.admin_acesso=valor;
    st.style.color='var(--vd)';
    st.textContent=valor==='nenhuma'?'✓ O admin deixou de ver esta garrafeira.'
      :valor==='leitura'?'✓ O admin passa a ver, sem mexer.'
      :'✓ O admin passa a ver e a mexer.';
  }catch(e){
    g.admin_acesso=antes;
    const sel=document.getElementById('ga-admin');if(sel)sel.value=antes;
    st.style.color='var(--dg)';st.textContent=e.message;
  }
}

/* Uma segunda garrafeira. A primeira nasce sozinha (`garantir_garrafeira`),
   esta é escolha explícita — por isso é um POST normal e não a RPC, que
   devolveria a que já existe em vez de criar outra. */
async function criarGarrafeira(){
  const inp=document.getElementById('ga-nova');
  const st=document.getElementById('ga-nova-status');
  const nome=inp.value.trim();
  if(!nome){st.style.color='var(--dg)';st.textContent='Dá-lhe um nome.';return;}
  st.style.color='var(--mu)';st.textContent='A criar…';
  try{
    const r=await sbReq('POST','garrafeiras',[{nome,dono:EU.email}],{'Prefer':'return=representation'});
    GA_LISTA.push(r[0]);
    GA_LISTA.sort((a,b)=>String(a.nome).localeCompare(String(b.nome),'pt'));
    inp.value='';
    await trocarGarrafeira(r[0].id);
  }catch(e){st.style.color='var(--dg)';st.textContent=e.message;}
}

/* Trocar de garrafeira é recarregar SÓ o conteúdo (`carregarGarrafeira`) —
   quem eu sou e a lista de garrafeiras não mudaram. Os filtros e o painel
   do resumo ficam para trás de propósito: apontavam para locais e castas
   da garrafeira anterior, e um filtro por um local que já não existe é uma
   lista vazia sem explicação. */
async function trocarGarrafeira(id){
  if(!id||id===GA_ID)return;
  if(!GA_LISTA.some(g=>g.id===id))return;
  const antes=GA_ID;
  GA_ID=id;localStorage.setItem(GA_KEY,String(id));
  fecharModal('modal-vinho');
  esquecerFiltros();
  RESUMO_ABERTO=null;RESUMO_DRILL=null;
  try{
    await carregarGarrafeira();
  }catch(e){
    GA_ID=antes;localStorage.setItem(GA_KEY,String(antes));
    toast('Não foi possível abrir essa garrafeira: '+e.message,1);
    return;
  }
  renderLista();renderCfg();
  toast('A ver: '+nomeGarrafeira());
}
function trocarGarrafeiraDelta(delta){
  if(!GA_LISTA.length||GA_ID==null)return;
  const i=GA_LISTA.findIndex(g=>g.id===GA_ID);
  if(i<0)return;
  const n=(i+delta+GA_LISTA.length)%GA_LISTA.length;
  trocarGarrafeira(GA_LISTA[n].id);
}

async function renderPartilhas(){
  const box=document.getElementById('cfg-partilhas');
  if(!box||!GA_ID)return;
  try{
    const l=await sbReq('GET',`partilhas?garrafeira_id=eq.${GA_ID}&select=email,criado_em&order=email.asc`);
    box.innerHTML=(l||[]).map(x=>`<div class="ua-row">
      <span class="em">${esc(x.email)}</span>
      <span class="tagme">só vê</span>
      <button class="jdel" title="Deixar de partilhar" onclick="tirarPartilha('${escJs(x.email)}')">✕</button>
    </div>`).join('')||'<div class="note" style="padding:6px 0">Só tu vês esta garrafeira.</div>';
  }catch(e){box.innerHTML=`<div class="note">${esc(e.message)}</div>`;}
}

async function partilharGarrafeira(){
  const inp=document.getElementById('ga-partilhar');
  const st=document.getElementById('ga-partilhar-status');
  const email=inp.value.trim().toLowerCase();
  if(!email||!email.includes('@')){st.style.color='var(--dg)';st.textContent='Email inválido.';return;}
  st.style.color='var(--mu)';st.textContent='A partilhar…';
  try{
    await sbReq('POST','partilhas',[{garrafeira_id:GA_ID,email}],
      {'Prefer':'return=minimal,resolution=ignore-duplicates'});
    inp.value='';st.style.color='var(--vd)';st.textContent='✓ Partilhada.';
    renderPartilhas();
  }catch(e){st.style.color='var(--dg)';st.textContent=e.message;}
}

async function tirarPartilha(email){
  if(!confirm(`${email} deixa de ver esta garrafeira?`))return;
  try{
    await sbReq('DELETE',`partilhas?garrafeira_id=eq.${GA_ID}&email=eq.${encodeURIComponent(email)}`);
    renderPartilhas();toast('Partilha retirada');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}

// Quem recebeu uma garrafeira emprestada pode devolvê-la sem ter de pedir
// ao dono (a policy `p_del` deixa apagar a própria linha).
async function devolverGarrafeira(){
  const g=garrafeiraAtiva();
  if(!g||souDonoDaGarrafeira(g))return;
  if(!confirm(`Deixar de ver "${g.nome}"?\n\nSó ${g.dono} te pode voltar a dar acesso.`))return;
  try{
    await sbReq('DELETE',`partilhas?garrafeira_id=eq.${g.id}&email=eq.${encodeURIComponent(EU.email)}`);
    localStorage.removeItem(GA_KEY);
    await carregar();
    renderLista();renderCfg();
    // Se a garrafeira continua à vista, o acesso não vinha de uma partilha
    // — vinha do `admin_acesso` que o dono deu ao admin, e esse só ele o
    // tira. Dizê-lo é melhor do que um "✓ feito" com a lista igual.
    toast(GA_LISTA.some(x=>x.id===g.id)
      ?`Continuas a ver "${g.nome}": o acesso vem das permissões que ${g.dono} deu ao admin.`
      :'Já não vês essa garrafeira');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}

async function renomearGarrafeira(){
  const st=document.getElementById('ga-nome-status');
  const nome=document.getElementById('ga-nome').value.trim();
  if(!nome){st.style.color='var(--dg)';st.textContent='O nome não pode ficar vazio.';return;}
  st.style.color='var(--mu)';st.textContent='A guardar…';
  try{
    await sbReq('PATCH',`garrafeiras?id=eq.${GA_ID}`,{nome});
    const g=garrafeiraAtiva();if(g)g.nome=nome;
    // O nome aparece em três sítios (cabeçalho, seletor, "Sobre"), por isso
    // refaz-se o separador todo — e SÓ DEPOIS se escreve o "Guardado ✓",
    // porque o `renderCfg()` deitou fora o `st` que estava aqui em cima.
    aplicarCabecalho();renderCfg();
    const st2=document.getElementById('ga-nome-status');
    if(st2){st2.style.color='var(--vd)';st2.textContent='Guardado ✓';}
  }catch(e){st.style.color='var(--dg)';st.textContent=e.message;}
}

async function passarGarrafeira(){
  const st=document.getElementById('ga-passar-status');
  const email=document.getElementById('ga-passar').value.trim().toLowerCase();
  const g=garrafeiraAtiva();
  if(!g)return;
  if(!email||!email.includes('@')){st.style.color='var(--dg)';st.textContent='Email inválido.';return;}
  if(!confirm(`Passar "${g.nome}" para ${email}?\n\nAs ${db.vinhos.length} fichas de vinho, `+
    `as ${db.garrafas.length} garrafas e o histórico de consumos passam a ser dele. `+
    `Deixas de os ver, a não ser que ele volte a partilhar contigo.`))return;
  st.style.color='var(--mu)';st.textContent='A passar…';
  try{
    await sbRpc('transferir_garrafeira',{p_gid:g.id,p_email:email});
    localStorage.removeItem(GA_KEY);
    st.style.color='var(--vd)';st.textContent='✓ Feito. A recarregar…';
    setTimeout(()=>window.location.reload(),1200);
  }catch(e){st.style.color='var(--dg)';st.textContent=e.message;}
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
// Aprovar passou a incluir `pode_editar`. Antes isso era dar-lhe acesso de
// escrita À GARRAFEIRA DE CASA e por isso era um segundo passo pensado;
// agora só lhe dá direito à garrafeira DELE, que é a coisa toda que ele vem
// cá fazer. Quem quiser alguém a ver e mais nada tira a marca a seguir.
async function admAprovar(email){
  try{
    await sbReq('POST','allowed_users',[{email,pode_editar:true}],{'Prefer':'return=minimal,resolution=ignore-duplicates'});
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
const IA_PLANOS=[
  {v:'sem_ia',r:'sem IA'},
  {v:'gratis',r:'IA sem pesquisa web'},
  {v:'premium',r:'IA com pesquisa web (Grounding Search)'}
];
async function admRenderUtilizadores(){
  const box=document.getElementById('adm-users-list');
  if(!box)return;
  try{
    _admUsers=await sbReq('GET','allowed_users?select=email,nome,pode_editar,ia_plano&order=email.asc')||[];
  }catch(e){box.innerHTML=`<div class="note">${esc(e.message)}</div>`;return;}
  box.innerHTML=_admUsers.map(u=>{
    const eAdmin=u.email.toLowerCase()===String(ADMIN_EMAIL).toLowerCase();
    return `<div class="ua-row">
      <span class="em">${esc(u.email)}${u.nome?' ('+esc(u.nome)+')':''}</span>
      ${eAdmin?'<span class="tagme">admin · IA com pesquisa web</span>'
        :`<div class="ua-ctrls">
            <label class="chk" title="Tem garrafeira própria e pode mexer-lhe"><input type="checkbox"${u.pode_editar?' checked':''}
              onchange="admToggleEditor('${escJs(u.email)}',this.checked)"> Editor</label>
            <select class="mini" title="Plano de pesquisa por IA" onchange="admDefinirPlano('${escJs(u.email)}',this.value)">
              ${IA_PLANOS.map(p=>`<option value="${p.v}"${(u.ia_plano||'sem_ia')===p.v?' selected':''}>${p.r}</option>`).join('')}
            </select>
            <button class="jdel" title="Tirar acesso" onclick="admTirarAcesso('${escJs(u.email)}')">✕</button>
          </div>`}
    </div>`;
  }).join('')||'<div class="note" style="padding:6px 0">Ninguém na lista.</div>';

  // O select da password temporária sai da MESMA lista — nunca pode
  // oferecer alguém que não tenha acesso.
  const outros=_admUsers.filter(u=>u.email.toLowerCase()!==String(ADMIN_EMAIL).toLowerCase());
  const op=l=>l.map(u=>`<option value="${esc(u.email)}">${esc(u.email)}</option>`).join('');
  const s1=document.getElementById('adm-pt-email');
  if(s1)s1.innerHTML=outros.length?op(outros):'<option value="">(mais ninguém tem acesso)</option>';
}
async function admToggleEditor(email,val){
  try{
    await sbReq('PATCH',`allowed_users?email=eq.${encodeURIComponent(email)}`,{pode_editar:val});
    toast(val?email+' passa a ter garrafeira própria':email+' fica só a ver');
  }catch(e){toast('Não foi possível: '+e.message,1);admRenderUtilizadores();}
}
async function admDefinirPlano(email,plano){
  if(!IA_PLANOS.some(p=>p.v===plano)){admRenderUtilizadores();return;}
  try{
    await sbReq('PATCH',`allowed_users?email=eq.${encodeURIComponent(email)}`,{ia_plano:plano});
    toast(email+' fica com '+(IA_PLANOS.find(p=>p.v===plano)||{}).r);
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
    await sbReq('POST','allowed_users',[{email,pode_editar:true}],{'Prefer':'return=minimal,resolution=ignore-duplicates'});
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
/* ── EXPORTAR ──────────────────────────────────────────────────────── */
/* ── EXPORTAR A LISTA PARA PDF ─────────────────────────────────────
   Sem biblioteca nenhuma, que aqui não há build: monta-se um DOCUMENTO
   COMPLETO — o seu próprio `<html>`, com o seu próprio CSS — mostra-se numa
   pré-visualização, e quem imprime escolhe "Guardar como PDF" (no iOS é o
   próprio menu de partilha). Uma biblioteca de PDF eram centenas de KB para
   um resultado pior do que o que o browser já sabe fazer.

   O documento vive num `<iframe srcdoc>` e NÃO num `#print-area` dentro da
   app. Essa diferença é o que faz a folha deixar de sair em branco — eram
   três causas, e o iframe mata as três de uma vez:

   - **a folha era montada na página viva** e a app inteira era escondida por
     `body>*{display:none!important}`. A folha ficava refém do style.css da
     app: bastava uma regra a ganhar (um modal `fixed` por cima, o `@page` a
     discordar do que o iOS quer fazer com a orientação) para ir uma folha
     vazia para o papel;
   - **o `afterprint` limpava o `#print-area`** — e no WebKit o `afterprint`
     dispara antes de o PDF estar mesmo gerado: o `print()` volta e o ecrã de
     partilha do iOS ainda está a rasterizar. O conteúdo desaparecia debaixo
     do trabalho de impressão. É uma corrida, e é por isso que era "muitas
     vezes", não sempre;
   - **o `print()` saía de dois `requestAnimationFrame`**, ou seja, fora do
     gesto do utilizador: o Safari trava isso ("impedido de imprimir
     automaticamente"), e num telemóvel que troca de ecrã a meio os rAF nem
     chegam a correr — não saía nada.

   Agora o `print()` é um clique numa barra que está à frente de quem está a
   imprimir, sobre um documento isolado que ele ACABOU de ver. Uma folha em
   branco deixa de poder passar despercebida — e deixa de acontecer, porque o
   documento não depende de uma única regra da app. */
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

  const sub=`${res.length} vinho${res.length===1?'':'s'} · ${nGar} garrafa${nGar===1?'':'s'} · `+
            `por ${DET_AGRUPAR==='ano'?'ano':DET_AGRUPAR==='casta'?'casta':'região'}`;

  pdfPreAbrir(`
    <div class="pcab">
      <div><h1>Garrafeira</h1><div class="psub">${esc(sub)}</div></div>
      <div class="pdata">${esc(dataPT(hoje()))}</div>
    </div>
    <div class="pwrap">
      <table>
        <thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`,'Garrafeira');
}

/* ── A FOLHA E A SUA PRÉ-VISUALIZAÇÃO ──────────────────────────────
   O CSS da folha vive AQUI, não no style.css: é o documento que o iframe
   recebe, e é isso que o põe fora do alcance de qualquer regra da app.
   Se um dia houver uma segunda folha (os consumidos, um local), passa por
   estas duas funções — não voltes a montar um documento à mão.

   A folha é desenhada para o PAPEL (A4 horizontal, doze colunas), mas
   também tem de se ler na pré-visualização de um telemóvel com 390px. Em
   vez de encolher a letra até os nomes se partirem, a tabela tem largura
   mínima e desliza na horizontal dentro da `.pwrap`; a imprimir, a caixa
   deixa de a apertar e a folha fica exatamente como foi desenhada. */
/* As regras que só valem NO PAPEL — tamanhos menores, largura cheia (a
   pré-visualização usa tamanhos maiores e desliza na horizontal, ver
   PDF_CSS). Vivem numa string à parte porque servem DUAS vezes: dentro de
   `@media print` (a impressão a sério) e, prefixadas por classe, dentro de
   `calcularQuebras()` (medir a folha como vai sair impressa, SEM chegar a
   imprimir — ver PDF_SCRIPT). As duas cópias vêm da MESMA string via
   `cssComPrefixo`; não as separes, ou um dia deixam de bater certo e as
   quebras calculam-se com tamanhos que não são os do papel. */
const PDF_CSS_IMPRESSAO=`
    body{padding:0;font-size:7.6pt}
    .pwrap{overflow:visible}
    table{min-width:0}
    h1{font-size:17pt}
    .psub,.pdata{font-size:8pt}
    th{font-size:6.6pt;padding:3pt 4pt}
    td{padding:3pt 4pt;border-bottom:.6pt solid #ccc}
    .pgrupo td{border-bottom:.6pt solid #7b1f3d}
    .pnome{font-size:8.2pt}
    .pgrupo td{font-size:8.6pt;padding-top:6pt}
`;
// ".a{x} .b,.c{y}" -> "PREFIXO .a{x} PREFIXO .b,PREFIXO .c{y}" — usado
// para ativar as regras de PDF_CSS_IMPRESSAO por CLASSE em vez de por
// @media, só para as medir (nunca para as imprimir a sério).
function cssComPrefixo(css,prefixo){
  return css.replace(/([^{}]+)\{([^{}]*)\}/g,(m,sel,decl)=>
    sel.split(',').map(s=>prefixo+' '+s.trim()).join(',')+'{'+decl+'}');
}

const PDF_CSS=`
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;color:#241d1c;background:#fff;
    font-size:11px;line-height:1.45;padding:18px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .pcab{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;
    border-bottom:2px solid #7b1f3d;padding-bottom:7px;margin-bottom:10px}
  h1{font-family:'Fraunces','Iowan Old Style',Georgia,serif;font-weight:600;font-size:23px;
    color:#7b1f3d;line-height:1}
  .psub{font-size:11px;color:#7a6d68;margin-top:3px}
  .pdata{font-size:11px;color:#7a6d68;white-space:nowrap}
  .pwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  /* border-collapse:SEPARATE (com spacing:0), não collapse — de propósito.
     Com collapse, o break-inside:avoid de uma <tr> é ignorado nalguns
     motores. Visualmente não muda nada — só há border-bottom (nunca
     laterais nem topo), por isso não há bordos a duplicar-se nos cantos
     que o collapse evitava. Fica como rede de segurança: quem realmente
     decide onde a folha quebra é o calcularQuebras() ali em baixo, não
     este avoid — ver a explicação grande a seguir ao PDF_SCRIPT. */
  table{width:100%;border-collapse:separate;border-spacing:0;min-width:900px}
  thead{display:table-header-group}   /* o cabeçalho repete-se em cada página */
  tr{page-break-inside:avoid;break-inside:avoid}
  tr.quebra-pagina{page-break-before:always;break-before:page}
  th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.4px;
    color:#7b1f3d;border-bottom:1px solid #7b1f3d;padding:4px 5px;white-space:nowrap}
  /* O filete entre vinhos é CINZENTO (#ccc) e não um tom da paleta da app.
     Chegou a ser o bege dos rebordos (#e8dfd4) e a folha ficou a parecer
     sem divisórias: o bege foi escolhido para o fundo de papel da app,
     e sobre papel branco a sério não se lê. A espessura é 1px (.6pt no
     papel) — .6px pintava, mas um bordo de sub-pixel é frágil de motor
     para motor e aqui não se ganha nada com ele.
     CUIDADO: isto está DENTRO de um template literal do app.js — nada
     de plicas inclinadas aqui, que fecham a string e partem o ficheiro. */
  td{padding:4px 5px;border-bottom:1px solid #ccc;vertical-align:top}
  .pnome{font-family:'Fraunces','Iowan Old Style',Georgia,serif;font-weight:600;font-size:12px}
  .pc{text-align:center;white-space:nowrap}
  .pgrupo td{font-family:'Fraunces','Iowan Old Style',Georgia,serif;font-weight:600;font-size:12.5px;
    color:#7b1f3d;background:#f6f1ea;padding-top:8px;border-bottom:1px solid #7b1f3d}
  /* No iOS a "Orientação" do ecrã de impressão é do próprio sistema e o
     toggle Vertical/Horizontal não obedece a nenhum @page. Fica o pedido
     padrão (que o desktop respeita); quem imprimir no iOS toca no ícone
     horizontal no ecrã de Opções. */
  @page{size:A4 landscape;margin:9mm}
  @media print{${PDF_CSS_IMPRESSAO}}
  /* A MESMA folha de estilos de cima, mas ativada por CLASSE em vez de
     por @media — só serve para o calcularQuebras() MEDIR a folha como
     ela vai sair impressa, sem chegar a imprimir a sério (ver
     PDF_SCRIPT). Gerada da mesma string por cssComPrefixo: nunca
     escrevas isto uma segunda vez à mão, os dois ficavam a poder
     discordar. Sem @media, isto não muda nada no ecrã em uso normal —
     break-before só significa alguma coisa quando se está mesmo a
     imprimir, e a classe só fica ligada durante uma medição instantânea. */
  ${cssComPrefixo(PDF_CSS_IMPRESSAO,'html.medir-impressao')}
`;

// O documento é servido por `srcdoc`, logo é da MESMA origem — é isso que
// deixa chamar-lhe o `print()` a partir daqui. As fontes vêm do mesmo sítio
// de onde a app as traz, para o papel ter a letra da app; sem rede, as
// alternativas (Georgia/system-ui) já estão na cascata e nada fica à espera.
/* ── AS QUEBRAS DE PÁGINA CALCULAM-SE EM JS, NÃO SE DEIXAM AO MOTOR ──
   Havia aqui só CSS (`break-inside:avoid` na <tr>, `break-after:avoid` no
   cabeçalho do grupo) — e um vinho com garrafas em dois locais diferentes
   (linha alta, várias sub-linhas) continuava a sair CORTADO A MEIO entre
   duas páginas num iPhone a sério (AirPrint/WebKit), com `border-collapse:
   separate` e tudo. O `avoid` é um PEDIDO ao motor de impressão — "se
   puderes, não partas isto" — e este motor, quando a linha não cabe no
   que sobra da página, ignora o pedido e parte-a na mesma. Não há CSS que
   force isso a sério; a spec chama a este mecanismo "fragmentação
   forçada" a `break-before:always/page`, que TODOS os motores respeitam
   (é uma ordem, não um pedido) — e é aí que este código se agarra.

   O truque: em vez de pedir "não partas esta linha", calcula-se ANTES de
   imprimir exatamente que linhas cabem em cada página (medindo a altura
   REAL de cada `<tr>` sob o CSS de impressão — `.medir-impressao` liga
   por classe as mesmas regras do `@media print`, sem chegar a imprimir) e
   marca-se com `quebra-pagina` (`break-before:page`) só a linha que NÃO
   cabia. Como cada página passa a começar exatamente onde nós dissemos,
   o motor nunca chega a ter de decidir "isto não cabe, corto ou empurro?"
   — a pergunta que ele responde mal deixa de se pôr.

   O cabeçalho de um grupo (região/ano/casta) é medido JUNTO com o vinho
   a seguir: se os dois não cabem, quebra-se ANTES do cabeçalho, nunca
   entre ele e o primeiro vinho — o mesmo raciocínio que o `break-after:
   avoid` tentava (e que se tirou daqui: com as quebras já calculadas ao
   pormenor, um `avoid` a mais só arriscava discordar do que este código
   decidiu). */
const PDF_SCRIPT=`
(function(){
  function calcularQuebras(){
    var raiz=document.documentElement;
    var tabela=document.querySelector('table');
    if(!tabela)return;
    var corpo=tabela.tBodies[0];
    if(!corpo)return;
    var linhas=Array.prototype.slice.call(corpo.rows);
    // reabrir a pré-visualização ou recalcular (beforeprint) não pode
    // empilhar quebras em cima de quebras de uma vez anterior.
    linhas.forEach(function(l){l.classList.remove('quebra-pagina');});
    if(!linhas.length)return;

    raiz.classList.add('medir-impressao');
    // 1mm = 96/25.4px (a definição CSS de px, igual em ecrã e em papel).
    // @page é A4 horizontal com 9mm de margem — os mesmos números do
    // PDF_CSS ali em cima; muda um, muda o outro.
    var mmPx=96/25.4;
    var alturaUtil=(210-9-9)*mmPx;
    var larguraUtil=(297-9-9)*mmPx;
    // A LARGURA da medição tem de ser a do PAPEL, não a do ecrã onde a
    // pré-visualização está a abrir. Sem isto, um telemóvel estreito
    // (390px) media a tabela toda enrolada — mais palavras a quebrar
    // linha em cada célula, linhas mais altas, quebras a mais e no sítio
    // errado — enquanto um ecrã largo dava outro número qualquer para o
    // MESMO documento. .pwrap é o único elemento com largura própria (a
    // tabela em si já vai a min-width:0 sob medir-impressao); impor-lhe
    // a largura do papel torna a medição igual em qualquer ecrã,
    // exatamente como vai sair impressa.
    var wrap=document.querySelector('.pwrap');
    var larguraAntiga=wrap?wrap.style.width:null;
    if(wrap)wrap.style.width=larguraUtil+'px';

    var cabecalho=document.querySelector('.pcab');
    var alturaCabecalho=cabecalho?cabecalho.getBoundingClientRect().height:0;
    var alturaThead=tabela.tHead?tabela.tHead.getBoundingClientRect().height:0;

    var restante=alturaUtil-alturaCabecalho-alturaThead;
    for(var i=0;i<linhas.length;i++){
      var l=linhas[i];
      var altura=l.getBoundingClientRect().height;
      var alturaComOSeguinte=altura;
      if(l.classList.contains('pgrupo')&&linhas[i+1]){
        alturaComOSeguinte+=linhas[i+1].getBoundingClientRect().height;
      }
      if(i>0&&alturaComOSeguinte>restante+0.5){
        l.classList.add('quebra-pagina');
        restante=alturaUtil-alturaThead;
      }
      restante-=altura;
    }
    if(wrap)wrap.style.width=larguraAntiga||'';
    raiz.classList.remove('medir-impressao');
  }
  function preparar(){
    // as Google Fonts chegam depois do <link> — sem esperar por elas, a
    // altura de cada linha media-se com a alternativa (Georgia/system-ui)
    // e as quebras calculavam-se erradas assim que a fonte a sério
    // chegasse. Mas document.fonts.ready NÃO TEM PRAZO: sem rede (ou com
    // uma ligação parva a meio caminho), pode nunca resolver — e o botão
    // de imprimir ficava preso em "A preparar…" para sempre, pior do que
    // o problema que isto veio corrigir. 3s chega de sobra para uma
    // fonte que carrega a sério; passado isso, mede-se com o que houver
    // (Georgia/system-ui, já na cascata) em vez de continuar à espera.
    const semPrazo=p=>Promise.race([p,new Promise(r=>setTimeout(r,3000))]);
    window.pdfQuebrasProntas=semPrazo(document.fonts&&document.fonts.ready||Promise.resolve()).then(calcularQuebras);
    // rede de segurança: se a impressão for pedida por outro caminho que
    // não o botão da barra (não devia haver nenhum, mas nunca se sabe),
    // recalcula-se na mesma mesmo em cima da hora.
    window.addEventListener('beforeprint',calcularQuebras);
  }
  // este <script> vem ANTES da tabela no documento (ver pdfDocumento) —
  // de propósito, para não ficar preso atrás do <link rel=stylesheet> das
  // Google Fonts (um script clássico espera por uma folha de estilos
  // pendente antes de correr, mesmo sem precisar dela). Por isso a
  // tabela ainda não existe quando este código corre; DOMContentLoaded
  // não depende de CSS nenhum e dispara assim que o HTML estiver todo
  // interpretado — ao contrário de 'load', que esperaria pelas fontes.
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',preparar);
  else preparar();
})();
`;

function pdfDocumento(corpo,titulo){
  // O <script> vem ANTES de qualquer <link rel=stylesheet>, não no fim do
  // body — um script clássico colocado DEPOIS de uma folha de estilos
  // pendente espera por ela antes de correr (é a regra do próprio
  // browser: pode vir a precisar do CSSOM). Com a rede da Google Fonts
  // lenta ou em baixo, isso atrasava o calcularQuebras() sem necessidade
  // nenhuma — ele nem olha para a folha de estilos, só para a tabela. O
  // PDF_SCRIPT já sabe esperar pelo DOMContentLoaded por dentro (que não
  // depende de CSS nenhum), por isso pode vir logo ao início do <head>.
  return `<!DOCTYPE html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<script>${PDF_SCRIPT}<\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${PDF_CSS}</style></head><body>${corpo}</body></html>`;
}

function pdfPreAbrir(corpo,titulo){
  pdfPreFechar();
  const ov=document.createElement('div');
  ov.id='pdf-pre';
  ov.innerHTML=`
    <div class="pdfp-bar">
      <span class="pdfp-t">${esc(titulo)}</span>
      <div class="pdfp-acc">
        <button class="pdfp-btn prim" id="pdf-pre-imprimir" onclick="pdfPreImprimir()" disabled>A preparar…</button>
        <button class="pdfp-btn" onclick="pdfPreFechar()" aria-label="Fechar">✕</button>
      </div>
    </div>
    <iframe id="pdf-pre-frame" title="${esc(titulo)}"></iframe>`;
  document.body.appendChild(ov);
  const frame=document.getElementById('pdf-pre-frame');
  const botao=document.getElementById('pdf-pre-imprimir');
  const ligar=()=>{botao.disabled=false;botao.textContent='🖨 Imprimir / Guardar PDF';};
  // O botão nasce DESLIGADO — só liga quando o calcularQuebras() lá
  // dentro (PDF_SCRIPT) já correu. É o que impede o pdfPreImprimir() de
  // ter de ESPERAR por uma promessa antes do w.print(): um await ali
  // tirava a chamada de dentro do gesto síncrono do clique, e é
  // exatamente isso que o Safari trava como "impressão automática" — a
  // mesma lição do afterprint/rAF que já se pagou uma vez nesta folha.
  //
  // Espera-se por `pdfQuebrasProntas` A ESPREITAR (não pelo 'load' do
  // iframe): 'load' só dispara depois de TODOS os recursos — incluindo a
  // folha de estilos das Google Fonts — terminarem, e é exatamente essa
  // rede que pode estar lenta ou em baixo. O PDF_SCRIPT corre cedo (vem
  // antes de qualquer <link rel=stylesheet>, ver pdfDocumento) e não
  // depende de CSS nenhum, por isso a promessa costuma existir em
  // milissegundos — só se espreita, nunca se fica preso a render alheio.
  (function esperar(tentativas){
    const w=frame.contentWindow;
    if(w&&w.pdfQuebrasProntas){w.pdfQuebrasProntas.then(ligar);return;}
    if(tentativas<=0){ligar();return;}   // nunca chegou a aparecer — liga-se à mesma
    setTimeout(()=>esperar(tentativas-1),40);
  })(250);   // 250×40ms = 10s de tentativas, sobra para qualquer telemóvel lento
  frame.srcdoc=pdfDocumento(corpo,titulo);
}

function pdfPreFechar(){
  const ov=document.getElementById('pdf-pre');
  if(ov)ov.remove();
}

function pdfPreImprimir(){
  const f=document.getElementById('pdf-pre-frame');
  const w=f&&f.contentWindow;
  if(!w){toast('A folha ainda está a abrir — tenta outra vez',1);return;}
  try{w.focus();w.print();}
  catch(e){toast('O browser não deixou imprimir daqui. Usa o menu do browser › Imprimir.',1);}
  // devolve o foco à app: o w.focus() de cima manda-o para dentro do
  // iframe, e sem o repor aqui o Escape deixava de fechar a
  // pré-visualização (o teclado ficava a apontar para dentro dela, e o
  // 'keydown' da app não recebe eventos de outro documento).
  window.focus();
}

// ── IMPORTAR VINHOS POR IMAGENS ─────────────────────────────────────
let IMPORT_RESULTADO=[];

function importarAbrir(){
  if(roGuard())return;
  if(!podeUsarIA()){toast('A importação por IA não está incluída no teu acesso',1);return;}
  document.getElementById('modal-ia-in').innerHTML=
    "<div class='mtop'><div><h3>📷 Importar vinhos por imagens</h3><div class='note' style='margin-top:3px'>Até 3 fotos de rótulos, uma lista ou uma prateleira.</div></div><button class='mx' onclick=\"fecharModal('modal-ia')\">✕</button></div>"+
    "<div class='aviso'>As imagens são encolhidas no teu telemóvel, lidas pela IA e descartadas no fim. <b>Nada entra na garrafeira sem revisão tua.</b> A leitura não pesquisa na internet.</div>"+
    "<label>Imagens (máximo 3)</label><input id='imp-ficheiros' type='file' accept='image/jpeg,image/png,image/webp' multiple onchange='importarEscolha(this)'>"+
    "<div class='note' id='imp-estado' style='margin-top:8px'>Escolhe fotografias nítidas; podes juntar frente e verso do mesmo rótulo.</div>"+
    "<div class='macoes'><button class='btn prim' id='imp-btn' onclick='importarEnviar()'>Ler imagens</button><button class='btn ghost' onclick=\"fecharModal('modal-ia')\">Cancelar</button></div>";
  abrirModal('modal-ia');
}
function importarEscolha(input){
  const estado=document.getElementById('imp-estado'),n=(input.files||[]).length;
  if(n>3){estado.textContent='Escolheste '+n+' imagens; usa no máximo 3.';estado.style.color='var(--dg)';return;}
  estado.style.color='';estado.textContent=n?n+' imagem(ns) escolhida(s). Serão encolhidas antes de enviar.':'Escolhe fotografias nítidas; podes juntar frente e verso do mesmo rótulo.';
}
async function importarBase64(file){
  const blob=await encolherImagem(file,1400,0.82);
  const data=await new Promise((resolve,reject)=>{
    const r=new FileReader();r.onerror=()=>reject(new Error('não consegui ler essa imagem'));
    r.onload=()=>resolve(String(r.result||'').split(',')[1]||'');r.readAsDataURL(blob);
  });
  if(!data)throw new Error('não consegui preparar essa imagem');
  return {mime:'image/jpeg',data};
}
async function importarEnviar(){
  const input=document.getElementById('imp-ficheiros'),files=Array.from(input.files||[]);
  if(!files.length||files.length>3){toast('Escolhe entre 1 e 3 imagens',1);return;}
  const btn=document.getElementById('imp-btn'),estado=document.getElementById('imp-estado');
  btn.disabled=true;btn.textContent='A preparar…';estado.style.color='';
  try{
    const imagens=[];
    for(let i=0;i<files.length;i++){
      estado.textContent='A preparar imagem '+(i+1)+' de '+files.length+'…';
      imagens.push(await importarBase64(files[i]));
    }
    estado.textContent='A enviar para leitura…';btn.textContent='A ler…';
    const r=await sbFetch(SB_URL+'/functions/v1/importar-vinhos',{
      method:'POST',headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({garrafeiraId:GA_ID,imagens})
    });
    let d={};try{d=await r.json();}catch(_){}
    if(!r.ok){
      if(r.status===404)throw new Error('A função importar-vinhos ainda não está publicada no Supabase. Ver o README.');
      throw new Error(d.error||('O servidor respondeu HTTP '+r.status));
    }
    if(!d.id)throw new Error('A importação não devolveu identificador');
    importarEspera(d.id);
  }catch(e){
    estado.style.color='var(--dg)';estado.textContent='Não deu: '+e.message;
    btn.disabled=false;btn.textContent='Tentar outra vez';
  }
}
async function importarEspera(id){
  const estado=document.getElementById('imp-estado'),btn=document.getElementById('imp-btn'),fim=Date.now()+150000;
  btn.disabled=true;btn.textContent='A ler…';estado.textContent='A IA está a ler as imagens. Pode levar até dois minutos; mantém esta janela aberta para rever o resultado.';
  while(Date.now()<fim){
    await new Promise(resolve=>setTimeout(resolve,2500));
    try{
      const rows=await sbReq('GET','importacoes?id=eq.'+id+'&select=estado,resultado,erro');
      const job=(rows||[])[0];if(!job)continue;
      if(job.estado==='concluido'){importarMostrarResultado(job.resultado||{});return;}
      if(job.estado==='erro')throw new Error(job.erro||'a leitura falhou');
    }catch(e){
      estado.style.color='var(--dg)';estado.textContent='Não deu: '+e.message;
      btn.disabled=false;btn.textContent='Tentar outra vez';return;
    }
  }
  estado.textContent='Ainda está a processar. Podes fechar e tentar novamente daqui a pouco; não foi criado nenhum vinho.';
  btn.disabled=false;btn.textContent='Nova leitura';
}
function importarMostrarResultado(resultado){
  IMPORT_RESULTADO=Array.isArray(resultado.vinhos)?resultado.vinhos:[];
  const aviso=resultado.aviso?'<div class="aviso">'+esc(resultado.aviso)+'</div>':'';
  const linhas=IMPORT_RESULTADO.map((v,i)=>{
    const detalhes=[v.tipo,v.regiao,v.mencao,v.teor?v.teor+'%':'',(v.castas||[]).join(', ')].filter(Boolean).join(' · ');
    return "<div class='ia-linha' style='display:block;margin-top:10px'>"+
      "<label style='display:flex;gap:8px;align-items:center'><input type='checkbox' class='imp-sel' data-i='"+i+"' checked><b>"+esc(v.nome||'Sem nome')+"</b></label>"+
      "<div class='formgrid' style='margin-top:8px'><div><label>Nome</label><input class='imp-nome' data-i='"+i+"' value='"+esc(v.nome||"")+"'></div><div><label>Produtor</label><input class='imp-produtor' data-i='"+i+"' value='"+esc(v.produtor||"")+"'></div><div><label>Ano</label><input class='imp-ano' data-i='"+i+"' inputmode='numeric' value='"+esc(v.ano||"")+"'></div><div><label>Garrafas</label><input class='imp-qtd' data-i='"+i+"' type='number' min='1' max='60' value='"+esc(v.quantidade||1)+"'></div><div><label>Formato</label><select class='imp-formato' data-i='"+i+"'>"+FORMATOS.map(function(x){return "<option value='"+esc(x)+"'>"+esc(x)+"</option>";}).join('')+"</select></div></div>"+
      (detalhes?"<div class='note' style='margin-top:6px'>"+esc(detalhes)+"</div>":"")+
      (v.aviso?"<div class='note' style='margin-top:4px'>⚠️ "+esc(v.aviso)+"</div>":"")+"</div>";
  }).join('');
  document.getElementById('modal-ia-in').innerHTML=
    "<div class='mtop'><div><h3>Rever antes de importar</h3><div class='note' style='margin-top:3px'>"+IMPORT_RESULTADO.length+" vinho(s) proposto(s). Edita nome, produtor, ano ou quantidade antes de adicionar.</div></div><button class='mx' onclick=\"fecharModal('modal-ia')\">✕</button></div>"+
    aviso+(linhas||"<div class='note' style='margin-top:14px'>Não foi possível identificar nenhum vinho com segurança. Tenta fotos mais nítidas ou uma imagem de cada vez.</div>")+
    "<div class='macoes'><button class='btn prim' id='imp-guardar' "+(linhas?"onclick='importarGuardar()'":"disabled")+">Adicionar selecionados</button><button class='btn ghost' onclick=\"fecharModal('modal-ia')\">Cancelar</button></div>";
}
function importarValor(classe,i){
  const e=document.querySelector('.'+classe+'[data-i=\"'+i+'\"]');
  return e?e.value.trim():'';
}
async function importarGuardar(){
  const selecionados=Array.from(document.querySelectorAll('.imp-sel:checked')).map(e=>parseInt(e.dataset.i,10)).filter(Number.isInteger);
  if(!selecionados.length){toast('Seleciona pelo menos um vinho',1);return;}
  const btn=document.getElementById('imp-guardar');btn.disabled=true;btn.textContent='A adicionar…';
  let feitos=0;
  try{
    for(const i of selecionados){
      const origem=IMPORT_RESULTADO[i]||{},nome=importarValor('imp-nome',i);
      if(!nome)continue;
      const anoLido=inteiro(importarValor('imp-ano',i));
      const vinho=Object.assign({},origem,{nome,produtor:importarValor('imp-produtor',i),ano:(anoLido&&anoLido>=1900&&anoLido<=2100)?anoLido:null,garrafeira_id:GA_ID});
      const castas=Array.isArray(vinho.castas)?vinho.castas:[];delete vinho.castas;delete vinho.quantidade;delete vinho.aviso;
      if(TEM_ATUALIZADO)vinho.atualizado_em=new Date().toISOString();
      const criados=await sbReq('POST','vinhos',[vinho],{'Prefer':'return=representation'});
      const vinhoId=criados&&criados[0]&&criados[0].id;if(!vinhoId)throw new Error('não foi possível criar '+nome);
      if(castas.length)await sbRpc('definir_castas',{p_vinho_id:vinhoId,p_nomes:castas});
      const qtd=Math.max(1,Math.min(60,inteiro(importarValor('imp-qtd',i))||1));
      const formato=importarValor('imp-formato',i)||'0,75 L';
      await sbReq('POST','garrafas',Array.from({length:qtd},()=>({vinho_id:vinhoId,formato:formato})),{'Prefer':'return=minimal'});
      feitos++;
    }
    await carregarGarrafeira();await recarregarCastas();renderLista();fecharModal('modal-ia');
    toast(feitos+' vinho(s) e respetivas garrafas adicionados ✓');
  }catch(e){
    toast('A importação parou: '+e.message+'. O que já entrou ficou guardado.',1);
    btn.disabled=false;btn.textContent='Tentar guardar restantes';
  }
}

function exportarJSON(){
  const dados={
    garrafeira:nomeGarrafeira(),
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
function diagUsageHTML(d){
  const u=d&&d.usageMetadata;
  const n=v=>Number.isFinite(Number(v))?Math.round(Number(v)):0;
  if(!u||typeof u!=='object')return '';
  const prompt=n(u.promptTokenCount),resp=n(u.candidatesTokenCount),total=n(u.totalTokenCount);
  if(!(prompt||resp||total))return '';
  return `<div class="note">Tokens Gemini · prompt <b>${esc(String(prompt))}</b> · resposta <b>${esc(String(resp))}</b> · total <b>${esc(String(total))}</b></div>`;
}
function diagMetaHTML(d){
  const bits=[
    d&&d.modelo?`modelo ${esc(String(d.modelo))}`:'',
    d&&d.ms!=null?`${esc(String(d.ms))} ms`:'',
    d&&d.campos!=null?`${esc(String(d.campos))} campos`:''
  ].filter(Boolean);
  return bits.length?`<div class="note">${bits.join(' · ')}</div>`:'';
}
async function renderDiag(){
  const box=document.getElementById('diag-box');
  box.innerHTML='<div class="note">A ler…</div>';
  try{
    const l=await sbReq('GET','sync_log?select=*&order=criado_em.desc&limit=25');
    if(!l||!l.length){box.innerHTML='<div class="note">Sem registos ainda.</div>';return;}
    box.innerHTML=l.map(r=>`<div class="diag-l">
      <b>${esc(r.estado)}</b> · ${esc(String(r.criado_em).slice(0,19).replace('T',' '))} · ${esc(r.origem)}
      ${r.acao?' · '+esc(r.acao):''}${r.quem?' · '+esc(r.quem):''}
      ${diagMetaHTML(r.detalhe||{})}
      ${diagUsageHTML(r.detalhe||{})}
      <div class="note">${esc(JSON.stringify(r.detalhe||{}).slice(0,500))}</div></div>`).join('');
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
window.addEventListener('resize',()=>{if(MAPA_POP_LOCAL&&MAPA_POP_ANCHOR)mapaPopupPos(MAPA_POP_ANCHOR);});
window.addEventListener('scroll',()=>{if(MAPA_POP_LOCAL&&MAPA_POP_ANCHOR)mapaPopupPos(MAPA_POP_ANCHOR);},true);
// Noutra largura o nome do vinho quebra noutro sítio: as alturas medidas
// deixam de servir e o cabeçalho ficava com a altura do ecrã anterior.
window.addEventListener('resize',()=>{
  if(document.getElementById('modal-vinho').classList.contains('on'))pgMedirEncolhe();
});

// Enter no campo de procura fecha o teclado do telemóvel (em vez de
// submeter coisa nenhuma, que era o que o browser tentava fazer).
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.id==='f-texto'){e.preventDefault();e.target.blur();}
  // A pré-visualização da folha está por cima de tudo — sai primeiro, e
  // sozinha: fechá-la não é sair também do vinho que está por baixo.
  if(e.key==='Escape'&&document.getElementById('pdf-pre')){pdfPreFechar();return;}
  if(e.key==='Escape'&&MAPA_POP_LOCAL){mapaPopupFechar();return;}
  // A folha do formato está por cima do modal do local: sai só ela, senão
  // levava atrás o que já se tinha escrito no local.
  if(e.key==='Escape'&&document.getElementById('modal-formato').classList.contains('on')){fecharModal('modal-formato');return;}
  if(e.key==='Escape')document.querySelectorAll('.modal.on').forEach(m=>fecharModal(m.id));
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
// Começa fechado e só abre quando `carregar()` souber quem é quem. Ao
// contrário, havia um instante — entre o HTML aparecer e as permissões
// chegarem — em que quem só pode VER tinha o botão de apagar à frente.
document.body.classList.add('readonly','naoadmin','naodono','naominha');
ajustarSticky();
pgSwipe();
sbInit();
