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
// O admin é sempre premium na BD (garrafeira.plano_ia()) — isto NÃO muda
// isso, só o que o admin VÊ no seu próprio browser. Serve para testar o que
// os outros planos mostram (botões escondidos, "sem pesquisa web") sem ter
// de pedir a outra pessoa para experimentar. Guarda-se em localStorage e
// nunca se aplica a quem não é admin.
let IA_TESTE=null;
try{const t=localStorage.getItem('gf_ia_teste');if(['sem_ia','gratis','premium'].includes(t))IA_TESTE=t;}catch(e){}
function iaTesteMudar(v){
  IA_TESTE=['sem_ia','gratis','premium'].includes(v)?v:null;
  try{if(IA_TESTE)localStorage.setItem('gf_ia_teste',IA_TESTE);else localStorage.removeItem('gf_ia_teste');}catch(e){}
  sincronizarTabs();   // as Sugestões só aparecem com IA
}
// A UI só explica o plano; a Edge Function volta a confirmá-lo através da
// base de dados antes de tocar em qualquer chave Gemini.
function planoIA(){return isAdmin()?(IA_TESTE||'premium'):String(EU.ia_plano||'sem_ia');}
function podeUsarIA(){return planoIA()==='gratis'||planoIA()==='premium';}
// `planoIA()` é o DIREITO da pessoa; o MOTOR de cada procura é outra coisa.
// Cada um procura com o motor a que tem direito, e quem é premium pode pedir
// uma segunda opinião ao outro para os comparar (ver a secção da IA).
function temPremium(){return planoIA()==='premium';}
function motorDoPlano(){return temPremium()?'premium':'gratis';}
function rotuloMotor(m){
  if(m==='premium')return 'IA com pesquisa web (Grounding Search)';
  if(m==='manual')return 'pesquisa manual (colada)';
  if(m==='catalogo')return 'Catálogo partilhado';
  return 'IA sem pesquisa web';
}
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
  const t=document.getElementById('hdr-titulo');
  if(t)t.textContent=modoCat()?'Catálogo':'Garrafeira';
  if(modoCat()){
    el.textContent=`Todos os vinhos conhecidos · ${(CAT_VINHOS||[]).length}`;
    el.style.display='';ajustarSticky();return;
  }
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
  // Os CURADORES do catálogo (migração 32 · `db/curadores.sql` da
  // WineCatalog): quem o admin do catálogo escolheu. Criam vinhos no
  // Catálogo e o que corrigem na garrafeira chega à linha ligada (quem faz
  // isso é o trigger, na BD). Um soluço aqui não impede ninguém de entrar.
  const wc={'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'};
  const [cur,admCat]=await Promise.all([
    sbReq('POST','rpc/sou_curador',{},wc).catch(()=>false),
    sbReq('POST','rpc/sou_admin',{},wc).catch(()=>false)
  ]);
  EU.curador=cur===true;EU.admin_catalogo=admCat===true;

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
    db.locais=[];db.vinhos=[];db.garrafas=[];PRECOS_LOJA={};
    IMG_ASSINADA={};reindexar();aplicarPermissoes();return;
  }
  const f=`garrafeira_id=eq.${GA_ID}`;
  const [locais,vinhos,garrafas,vc,cn,pl]=await Promise.all([
    sbReq('GET',`locais?${f}&select=*&order=ordem.asc,nome.asc`),
    sbReq('GET',`vinhos?${f}&select=*&order=nome.asc`),
    sbReq('GET',`garrafas?${f}&select=*&order=id.asc`),
    // `vinho_castas` não tem `garrafeira_id` (a garrafeira dela é a do
    // vinho): a RLS já não deixa sair as linhas dos vinhos que não posso
    // ver, e as que sobram de outra garrafeira minha só ficam sem par no
    // `porVinho` — ninguém as procura.
    sbReq('GET','vinho_castas?select=*'),
    // `consumo_notas` não tem `garrafeira_id` pela mesma razão — a dela é
    // a da garrafa — e junta-se aqui como as castas: em `porGarrafa`.
    sbReq('GET','consumo_notas?select=*&order=criado_em.asc'),
    // Os preços das lojas vêm do CATÁLOGO, não da garrafeira (ver
    // "O PREÇO QUE CONTA"). Uma poupança e não uma dependência: se falhar,
    // cada vinho fica com o preço médio de sempre.
    sbRpc('precos_lojas',{p_garrafeira_id:GA_ID}).catch(()=>null),
    // O nome por extenso dos produtores oficiais ("Quinta Nova" → "Quinta
    // Nova de Nossa Senhora do Carmo"), do catálogo: só se lê na ficha do
    // vinho. Se falhar, a ficha fica sem ele.
    sbReq('POST','rpc/produtores_completos',{},{'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'}).catch(()=>null)
  ]).then(r=>{PROD_COMPLETO=(r[6]&&typeof r[6]==='object')?r[6]:{};return r;});
  db.locais=locais||[];db.vinhos=vinhos||[];db.garrafas=garrafas||[];
  PRECOS_LOJA=(pl&&typeof pl==='object')?pl:{};

  const porGarrafa={};(cn||[]).forEach(n=>{
    (porGarrafa[n.garrafa_id]=porGarrafa[n.garrafa_id]||[]).push(n);
  });
  db.garrafas.forEach(g=>{g.notas=porGarrafa[g.id]||[];});

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
  await detetarCaixaMadeira();
  await detetarDesejo();
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
// `garrafas.caixa_madeira` é coluna NOVA (migração 11) — mesmo padrão:
// enquanto não existir, a moldura de madeira fica desligada e a garrafa
// comporta-se como hoje. É da GARRAFA e não do vinho: o mesmo vinho pode
// ter uma garrafa na caixa de origem e outra solta na prateleira.
let TEM_CAIXA_MADEIRA=false;
async function detetarCaixaMadeira(){
  if(db.garrafas.length){TEM_CAIXA_MADEIRA=('caixa_madeira' in db.garrafas[0]);return;}
  try{await sbReq('GET','garrafas?select=caixa_madeira&limit=1');TEM_CAIXA_MADEIRA=true;}
  catch(e){TEM_CAIXA_MADEIRA=false;}
}
// `vinhos.desejado` é coluna NOVA (migração 15, a wishlist) — mesmo padrão:
// enquanto não existir, o separador Wishlist não aparece e o POST de um
// vinho novo não a leva (senão rebentava com 400).
let TEM_DESEJO=false;
async function detetarDesejo(){
  if(db.vinhos.length)TEM_DESEJO=('desejado' in db.vinhos[0]);
  else{
    try{await sbReq('GET','vinhos?select=desejado&limit=1');TEM_DESEJO=true;}
    catch(e){TEM_DESEJO=false;}
  }
  document.body.classList.toggle('sem-desejo',!TEM_DESEJO);
}
// Um vinho da wishlist: não tem garrafas e não está na garrafeira — quer-se.
function desejado(v){return !!(TEM_DESEJO&&v&&v.desejado);}

/* ── ÍNDICES E CÁLCULOS ────────────────────────────────────────────── */
let IDXV={}, IDXL={}, GARV={};
function reindexar(){
  IDXV={};db.vinhos.forEach(v=>IDXV[v.id]=v);
  // Os vinhos do CATÁLOGO entram com o id NEGATIVO (ver `catNormalizar`):
  // nunca colidem com um da garrafeira, e a página do vinho acha-os igual.
  (CAT_VINHOS||[]).forEach(v=>IDXV[v.id]=v);
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
// A foto de uma moldura carregou: a garrafa desenhada sai de trás, e decide-se
// como a foto cabe lá dentro pela FORMA dela — ver o `.alta` no style.css.
// Mais estreita do que 3:5, ou do que a moldura, é a garrafa recortada rente
// ao vidro → inteira (cortar-lhe os lados era cortar o vidro). Mais larga — a
// foto quadrada da loja, a de um rótulo, a minha — enche a altura.
function fotoCarregou(img){
  const p=img.parentNode;if(!p)return;
  p.classList.add('com-foto');
  const w=img.naturalWidth,h=img.naturalHeight,bw=img.clientWidth,bh=img.clientHeight;
  if(w&&h)img.classList.toggle('alta',w/h<Math.max(bw&&bh?bw/bh:0,.6));
}

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
    ${img?`<img src="${esc(img)}" alt="" loading="lazy" onload="fotoCarregou(this)" onerror="this.remove()">`:''}
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
  /* O LUGAR DE ENCOSTO ocupa a coluna de folga do lado da parede — a
     última (ou a primeira) meia-coluna da grelha do móvel. Fica na fila
     de BAIXO, que é onde a garrafa assenta, e não leva berço: ela está
     encostada ao lado do móvel, não deitada na régua (ver `ondaBgSVG`). */
  const encosto=[];
  if(!preview&&p){
    const fundo=(formato==='sobrepostos'&&capacidade>1)?2:1;
    if(p.encosto_dir)encosto.push({lugar:p.cod_dir,col:2*colsw-1,row:fundo,span:2,encosto:'dir'});
    if(p.encosto_esq)encosto.push({lugar:p.cod_esq,col:1,row:fundo,span:2,encosto:'esq'});
  }
  /* A fila em cima do móvel: CENTRADA como qualquer outra prateleira, e
     numerada T1…Tn (ver `chaveLugarLayout`). Já se encostou à parede que
     houvesse — e o que se lia não era uma fila em cima do móvel, era uma
     prateleira torta: todos os níveis centrados e este a fugir para um
     lado. Quem diz que estas garrafas estão em cima é o sítio onde a fila
     está (acima de tudo, sob o tecto), não o canto a que encosta. */
  if(!preview&&p&&p.topo){
    slots=Array.from({length:capacidade},(_,i)=>({lugar:'T'+(i+1),col:off+2*i+1,row:1,span:2,topo:true}));
    return {formato:'fila',mais_em,capacidade,base:0,slots,cols,colsw,rows:1,gridCols:2*colsw,span:2,topo:true};
  }
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
    /* Com capacidade ÍMPAR as duas filas ficam desencontradas meia coluna
       (a curta começa meia coluna à frente) e a de cima assenta nos vãos
       da de baixo, como se empilham garrafas a sério; com capacidade par
       ficam alinhadas e apenas se sobrepõem. Quem desenha isso é o
       `.desenc` no `style.css`. */
    const desenc=capacidade>1&&capacidade%2===1;
    return {formato,mais_em,capacidade,base,slots:slots.concat(encosto),cols,colsw,rows:capacidade>1?2:1,gridCols:2*colsw,span:2,desenc};
  }
  slots=Array.from({length:capacidade},(_,i)=>({lugar:base+i+1,col:off+2*i+1,row:1,span:2}));
  return {formato,mais_em,capacidade,base,slots:slots.concat(encosto),cols,colsw,rows:1,gridCols:2*colsw,span:2};
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
      out.push({nome,origem:nome,capacidade:capacidade-nCima,formato:'fila',mais_em:'cima',encaixe:false,
        encosto_dir:false,encosto_esq:false});
      if(nCima)out.push({nome,origem:nome,capacidade:nCima,formato:'fila',mais_em:'cima',encaixe:true,
        encosto_dir:!!(p&&p.encosto_dir),encosto_esq:!!(p&&p.encosto_esq)});
      return;
    }
    out.push({nome,origem:nome,capacidade,formato:normalizarFormatoPrateleira(p&&p.formato),
      mais_em:normalizarSobrepostosMaisEm(p&&p.mais_em),encaixe:!!(p&&p.encaixe),
      encosto_dir:!!(p&&p.encosto_dir),encosto_esq:!!(p&&p.encosto_esq)});
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
  // A RÉGUA é de todas as prateleiras, não só das que encaixam: um móvel
  // com dois desenhos diferentes (uma tábua maciça aqui, berços ali) lia-se
  // como dois móveis. Uma garrafa assenta num berço em U seja qual for o
  // formato do nível; o que o `encaixe` decide é o DESENCONTRO, não a
  // madeira. Quem fica sem ela é o seletor de posição, que passa
  // `ondulada:false` (ver `renderPickerPosicoes`).
  out.forEach(p=>{p.ondulada=true;});
  // A largura do móvel: o nível mais largo, mais uma coluna de folga de
  // CADA lado. Meia coluna de folga não chegava — uma prateleira desviada
  // gastava-a toda e o último lugar ficava cortado pela borda.
  const colsMax=out.reduce((m,p)=>Math.max(m,p.formato==='sobrepostos'?Math.ceil(p.capacidade/2):p.capacidade),1);
  out.forEach(p=>{p.colsw=colsMax+2;});
  /* O ENCOSTO só existe onde há parede: a folga de uma coluna que cada
     nível tem de cada lado (o `+2` acima) é exatamente o vão entre o fim
     da prateleira e a parede, e é lá que o lugar de encosto cai — sem
     mexer na largura do móvel nem na numeração de ninguém. */
  const par=paredesLocal(l);
  out.forEach((p,i)=>{
    p.nivel=numeroDoNivel(p.nome,i);
    p.encosto_dir=!!p.encosto_dir&&par.dir;
    p.encosto_esq=!!p.encosto_esq&&par.esq;
    p.cod_dir=p.nivel+'D';
    p.cod_esq=p.nivel+'E';
  });
  return out;
}
function temLayoutLocal(l){return layoutLocal(l).length>0;}
function lugaresLocal(l){return layoutLocal(l).reduce((s,p)=>s+p.capacidade,0)+especiaisLocal(l).length;}
// Os lugares da numeração corrida, sem os encostos nem o topo: é o que
// vale para "o lugar 12 existe?".
function lugaresCorridosLocal(l){return layoutLocal(l).reduce((s,p)=>s+p.capacidade,0);}
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
/* OS LUGARES DE ENCOSTO E DE TOPO — e porque é que NÃO entram na
   numeração corrida.

   Um local pode ter PAREDE à esquerda, à direita e/ou em cima
   (`layout.paredes`). Havendo parede, cada nível pode abrir UM lugar
   entre o fim da prateleira e a parede (`encosto_dir`/`encosto_esq`) —
   é onde entram as garrafas em caixa de madeira, encostadas ao lado do
   móvel; e, com parede em cima, o cimo do móvel leva uma fila de
   garrafas (`layout.topo.capacidade`).

   Se estes lugares entrassem na contagem corrida, abrir um encosto no
   Nível 3 empurrava a numeração de tudo o que está acima dele e todas
   as garrafas gravadas passavam a apontar para o lugar errado. Por isso
   têm CÓDIGO próprio e a numeração antiga fica intacta:
     15D / 15E — encosto à direita / à esquerda do Nível 15
     T1 … Tn   — a fila em cima do último nível
   (o número do encosto é o do NOME do nível, não a ordem no array: é o
   que a pessoa lê no rótulo.) */
function chaveLugarLayout(v){
  const s=String(v==null?'':v).trim().toUpperCase();
  if(!s)return null;
  const num=lugarNumeroLayout(s);
  if(num!=null)return String(num);
  return (/^\d+[DE]$/.test(s)||/^T\d+$/.test(s))?s:null;
}
function numeroDoNivel(nome,i){
  const m=String(nome==null?'':nome).match(/(\d+)/);
  return m?parseInt(m[1],10):i+1;
}
function paredesLocal(l){
  const p=(l&&l.layout&&l.layout.paredes)||{};
  return {esq:!!p.esq,dir:!!p.dir,topo:!!p.topo};
}
// Quantas garrafas cabem em cima do último nível. Só conta com parede em
// cima: sem ela não há nada que as segure.
function topoLocal(l){
  if(!paredesLocal(l).topo)return 0;
  return Math.max(0,Math.min(60,inteiro(l&&l.layout&&l.layout.topo&&l.layout.topo.capacidade)||0));
}
/* A fila de cima do móvel é uma prateleira A FINGIR: não está no array
   (não tem `base`, não numera nada) e existe só para se desenhar e para
   as garrafas lhe poderem apontar. Leva o `colsw` do móvel, que é o que a
   deixa centrada na mesma caixa dos níveis todos. */
function prateleiraTopo(l){
  const cap=topoLocal(l);
  if(!cap)return null;
  const prats=layoutLocal(l);
  return {nome:'Em cima',origem:'Em cima',capacidade:cap,formato:'fila',mais_em:'cima',
    encaixe:false,ondulada:false,topo:true,
    colsw:(prats[0]&&prats[0].colsw)||cap+2};
}
// Todos os lugares que NÃO são da numeração corrida, para as contagens.
function especiaisLocal(l){
  const out=[];
  layoutLocal(l).forEach(p=>{
    if(p.encosto_dir)out.push({codigo:p.cod_dir,prat:p});
    if(p.encosto_esq)out.push({codigo:p.cod_esq,prat:p});
  });
  const t=prateleiraTopo(l);
  if(t)for(let i=1;i<=t.capacidade;i++)out.push({codigo:'T'+i,prat:t});
  return out;
}
/* Com a numeração corrida, o número do lugar diz sozinho em que prateleira
   ele está. */
function prateleiraDoLugar(prats,lug){
  return (prats||[]).find(p=>lug>p.base&&lug<=p.base+p.capacidade)||null;
}
/* A prateleira de uma chave, seja ela um número corrido ou um código de
   encosto/topo. É por aqui que passa TUDO o que antes só sabia números. */
function prateleiraDaChave(l,k){
  if(!l||k==null)return null;
  const prats=layoutLocal(l);
  if(/^\d+$/.test(k))return prateleiraDoLugar(prats,parseInt(k,10));
  const mt=/^T(\d+)$/.exec(k);
  if(mt){
    const t=prateleiraTopo(l),i=parseInt(mt[1],10);
    return (t&&i>=1&&i<=t.capacidade)?t:null;
  }
  const me=/^(\d+)([DE])$/.exec(k);
  if(!me)return null;
  return prats.find(p=>String(p.nivel)===me[1]&&(me[2]==='D'?p.encosto_dir:p.encosto_esq))||null;
}
function nomeDaPosicao(localId,lugar){
  const l=IDXL[localId];
  const k=chaveLugarLayout(lugar);
  if(!l||k==null)return '';
  const def=prateleiraDaChave(l,k);
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
    const k=chaveLugarLayout(g.lugar);
    if(k==null)return;
    const def=prateleiraDaChave(l,k);
    if(!def)return;
    if(!nomeBatePrateleira(def,g.prateleira))return;
    (occ[k]=occ[k]||[]).push(g);
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
    const k=chaveLugarLayout(g.lugar);
    if(k==null)return true;
    const def=prateleiraDaChave(l,k);
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
  const k=chaveLugarLayout(raw);
  if(k==null)return 'Num local com desenho, o lugar é um número (12), um encosto (15D, 15E) ou o topo (T2).';
  if(/^\d+$/.test(k)){
    const total=lugaresCorridosLocal(l);
    const lug=parseInt(k,10);
    if(lug<1||lug>total)return `${l.nome} vai do lugar 1 ao ${total}.`;
  }else if(!prateleiraDaChave(l,k)){
    return `${l.nome} não tem o lugar ${k}. Abre-o primeiro em Editar local.`;
  }
  if((ocupacaoLayout(localId,ignorarGid)[k]||[]).length)
    return `O lugar ${k} já está ocupado.`;
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
/* Um valor que é um ENDEREÇO mostra-se como hiperligação nos ecrãs onde se
   aprova uma mudança (a procura da IA, o painel do catálogo). Só pelo texto
   do link ninguém sabe se o Vivino aponta para o vinho certo — e é
   exatamente isso que a app está ali a pedir para decidir; sem o <a> a única
   saída era copiar o URL à mão para outro separador.
   O texto continua a ser o endereço INTEIRO e não um "ver ↗": com dois links
   à frente um do outro, o que os distingue é o próprio endereço, e escondê-lo
   era tirar a única pista que se lê sem abrir nada.
   Dentro de um <label> (as caixas e os rádios da comparação) não há conflito:
   a spec manda o label ficar quieto quando o clique cai em conteúdo
   interativo lá dentro — abre-se o link e a escolha não mexe. */
function escLink(s){
  const t=String(s==null?'':s).trim();
  if(!/^https?:\/\/\S+$/i.test(t))return esc(s);
  return `<a class="lnk-val" href="${esc(t)}" target="_blank" rel="noopener">${esc(t)}<span class="lnk-ext">↗</span></a>`;
}
// A leitura por IA das imagens devolve por vezes o texto do rótulo tal e
// qual (CAIXA ALTA). Só mexe no que vier TODO em maiúsculas — um nome já
// bem escrito não se toca — e mantém as ligações ("dos", "da"…) em minúscula.
const CAPITALIZAR_MIN=new Set(['de','da','do','das','dos','e','a','o','em','no','na','nos','nas']);
function capitalizarLivre(s){
  s=String(s==null?'':s).trim();
  if(!s||s!==s.toUpperCase())return s;
  return s.toLowerCase().split(' ').map((w,i)=>w&&(i>0&&CAPITALIZAR_MIN.has(w))?w:(w.charAt(0).toUpperCase()+w.slice(1))).join(' ');
}
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
// A nota de um consumo tem uma casa decimal (4,2); as estrelas em texto são
// as da nota arredondada — o número exato vai ao lado (`avalFmt`).
function estrelas(n){if(!n)return '';const k=Math.round(n);return '★'.repeat(k)+'☆'.repeat(5-k);}
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
function abrirModal(id){document.getElementById(id).classList.add('on');fabFechar();}
function fecharModal(id){
  const el=document.getElementById(id);
  if(!el)return;
  el.classList.remove('on');
  // A página do vinho tem um passo próprio na história do browser (é o que
  // faz o "voltar" do telemóvel fechá-la em vez de sair da app). Sair por
  // aqui tem de o gastar, senão ficava um voltar que não fazia nada.
  if(id==='modal-vinho')pgSairHistoria();
  // Todos os caminhos de saída do modal da IA (✕, Escape, a margem, o fim
  // natural do lote) passam por aqui — é o único sítio onde arrumar o
  // estado de um lote a meio, sem repetir a limpeza em cada botão.
  if(id==='modal-ia')loteAoFecharModalIA();
}
// Fechar tocando no fundo (mas não ao arrastar de dentro para fora).
// A página do vinho não entra: aí o "fundo" são as margens da folha, e
// numa página ninguém espera sair por lhe tocar ao lado.
document.addEventListener('click',e=>{
  if(e.target.classList&&e.target.classList.contains('modal')&&!e.target.classList.contains('pagina'))
    fecharModal(e.target.id);
  if(MAPA_POP_LOCAL&&!e.target.closest('#mapa-pop,.msdot.cheia'))mapaPopupFechar();
});

/* ── O CATÁLOGO DENTRO DA GARRAFEIRA (fase 1, 30/09/2026) ──────────
   O dono das apps: "um separador idêntico ao Detalhe da Garrafeira, que
   em vez de ler os vinhos da garrafeira está a ler o Catálogo". É isso à
   letra: o MESMO Detalhe (procura, filtros, grupos, lista/grelha) e a MESMA
   página do vinho, só com outra fonte. Troca-se tocando no título do
   cabeçalho ("Garrafeira ⇄"), que muda de cor e passa a dizer "Catálogo".
   - Os vinhos do catálogo vêm TODOS de uma vez (`garrafeira.catalogo_vinhos`,
     migração 31, ~300 linhas): é o que deixa os filtros serem os de cá, do
     lado do browser, sem uma segunda cópia deles em SQL.
   - Levam o id NEGATIVO (`-id` do catálogo). É a marca "isto é do catálogo"
     em todo o lado (`v.id<0`), e nunca colide com um vinho da garrafeira no
     `IDXV`, nos `onclick` e nos preços (`CAT_PRECOS`).
   - Não se grava: o modo começa sempre na garrafeira. */
let MODO='garrafeira';
let CAT_VINHOS=null, CAT_PRECOS={}, CAT_A_CARREGAR=null;
let TAB_GARRAFEIRA='garrafeira';   // o separador da garrafeira de onde se saiu
function modoCat(){return MODO==='catalogo';}
// Tudo o que os filtros varrem: no catálogo, o catálogo todo; na garrafeira,
// os vinhos dela (o `passaFiltros` ainda corta os que não têm garrafas).
function vinhosUniverso(){return modoCat()?(CAT_VINHOS||[]):db.vinhos;}
// O que a lista mostra sem filtro nenhum.
function vinhosBase(){return modoCat()?(CAT_VINHOS||[]):db.vinhos.filter(v=>stockDe(v.id)>0);}
// O "Local" não é pergunta que se faça ao catálogo.
function camposVisiveis(){return (modoCat()||!temLocaisDesenhados())?F_CAMPOS.filter(([k])=>k!=='local'):F_CAMPOS;}
function catNormalizar(c){
  const v=Object.assign({},c);
  v.cat_id=c.id; v.id=-c.id;
  v.cat_ids=(c.ids||[c.id]).map(Number);
  v.castas=Array.isArray(c.castas)?c.castas.filter(Boolean).sort((a,b)=>String(a).localeCompare(String(b),'pt')):[];
  CAT_PRECOS[v.id]=Array.isArray(c.precos)?c.precos:[];
  delete v.precos; delete v.ids;
  return v;
}
function catCarregar(){
  if(CAT_VINHOS)return Promise.resolve(CAT_VINHOS);
  if(CAT_A_CARREGAR)return CAT_A_CARREGAR;
  // As notas vêm ao lado, e nunca deitam o catálogo abaixo: sem a migração
  // 33 (ou com um soluço), o catálogo abre sem elas.
  CAT_A_CARREGAR=Promise.all([
    sbRpc('catalogo_vinhos',{}),
    sbRpc('catalogo_notas',{}).then(x=>{TEM_NOTAS_CAT=true;return x;}).catch(()=>{TEM_NOTAS_CAT=false;return {};})
  ]).then(([r,notas])=>{
    CAT_PRECOS={};
    CAT_NOTAS=(notas&&typeof notas==='object'&&!Array.isArray(notas))?notas:{};
    CAT_VINHOS=(Array.isArray(r)?r:[]).map(catNormalizar);
    reindexar();
    return CAT_VINHOS;
  }).finally(()=>{CAT_A_CARREGAR=null;});
  return CAT_A_CARREGAR;
}
// Os vinhos DESTA garrafeira ligados a esta linha do catálogo (`catalogo_id`,
// migração 28) — também os ligados a uma linha fundida nela.
function catMeus(v){
  const ids=v.cat_ids||[];
  return db.vinhos.filter(x=>x.catalogo_id!=null&&ids.includes(Number(x.catalogo_id)));
}
// O que este vinho do catálogo é para mim: 'tenho' (garrafas na
// garrafeira), 'desejo' (na wishlist), 'bebido' (já o tive) ou '' (nada).
// Uma regra só para o crachá (`catTensHTML`) e para o fundo do cartão
// (`catFundoCls`): duas cópias desta ordem divergiam.
function catEstado(v){
  const meus=catMeus(v);
  const n=meus.reduce((s,m)=>s+stockDe(m.id),0);
  return {meus,n,que:!meus.length?'':n?'tenho':meus.some(desejado)?'desejo':'bebido'};
}
// No rodapé do cartão: o que tenho deste vinho, se tiver.
// E a média das notas de quem usa a Garrafeira (`catNotaBdgHTML`).
function catTensHTML(v,curto){
  const {n,que}=catEstado(v);
  if(!que)return catNotaBdgHTML(v,curto);
  const txt=que==='tenho'?(curto?`🍾 ${n}`:`🍾 Tens ${n} garrafa${n>1?'s':''}`)
    :que==='desejo'?(curto?'⭐':'⭐ Na tua wishlist'):(curto?'📖':'📖 Já bebido');
  return `<span class="bdg cat-tens">${txt}</span>`+catNotaBdgHTML(v,curto);
}
// O fundo do cartão no catálogo (30/09/2026, o dono das apps): verde suave
// no que tenho ou já tive (bebido), dourado suave no que está na wishlist.
function catFundoCls(v){
  if(!(v.id<0))return '';
  const q=catEstado(v).que;
  return q==='desejo'?' cat-desejo':q?' cat-tenho':'';
}
// Na página do vinho do catálogo, no lugar do "Onde está".
function catNaMinhaHTML(v){
  const meus=catMeus(v);
  const linhas=meus.map(m=>{
    const n=stockDe(m.id);
    const txt=n?`🍾 ${n} garrafa${n>1?'s':''} na garrafeira`:desejado(m)?'⭐ Na wishlist':'📖 Já bebido';
    return `<div class="mgar"><div class="g-onde"><b>${txt}</b>
      <i>${esc(m.nome)}${m.ano?' · '+m.ano:''}</i></div>
      <button class="mini" onclick="verVinho(${m.id})">Ver</button></div>`;
  }).join('');
  return `<div class="msec">${garrafeiraAtiva()&&!souDonoDaGarrafeira()?esc(nomeGarrafeira()):'Na tua garrafeira'}</div>
    ${linhas||'<div class="note" style="padding:8px 0">Ainda não está na garrafeira.</div>'}
    <div class="macoes ro-hide">
      <button class="btn prim" onclick="catPor(${v.id},'')">🍷 Pôr na garrafeira</button>
      ${TEM_DESEJO?`<button class="btn ghost" onclick="catPor(${v.id},'desejo')">⭐ Pôr na wishlist</button>`:''}
    </div>`;
}
/* ── AS NOTAS AOS VINHOS DO CATÁLOGO (migração 33, 30/09/2026) ──
   O dono das apps: "gostava que os utilizadores da garrafeira pudessem dar
   notas/avaliações aos vinhos do catálogo (notas de 0 a 5 … uma casa
   apenas)". Cada um dá a sua (`catalogo_nota_definir`), e vê-se a média de
   toda a gente e quantas notas há — nunca quem deu qual. A nota é de uma
   pessoa, não do vinho: não entra na ficha do catálogo.
   É o mesmo gesto da nota de um consumo (as estrelas dão o número redondo,
   a caixa ao lado a casa decimal), mas de 0 a 5 e gravada logo: uma
   estrela tocada, ou a caixa ao sair dela. */
let CAT_NOTAS={}, TEM_NOTAS_CAT=false;   // {id do catálogo: {media, n, minha}}
function catNota(v){return (v&&CAT_NOTAS[String(v.cat_id)])||null;}
function catNotaBdgHTML(v,curto){
  const x=catNota(v);
  if(!x||!x.n)return '';
  return `<span class="bdg cat-nota" title="Média das notas de quem usa a Garrafeira (${x.n})">👥 ${avalFmt(x.media)}${
    curto?'':` · ${x.n} nota${x.n>1?'s':''}`}</span>`;
}
const CAT_NOTA_VAZIO='Sem nota — toca numa estrela (outra vez na mesma para tirar) ou escreve-a ao lado, de 0 a 5.';
function catNotaLer(s){
  if(String(s??'').trim()==='')return null;
  const n=num(s);
  if(n==null||n<0||n>5)return NaN;
  return Math.round(n*10)/10;
}
function catNotaMediaHTML(v){
  const x=catNota(v);
  return x&&x.n?`Média de quem usa a Garrafeira: <b>${avalFmt(x.media)}</b> · ${x.n} nota${x.n>1?'s':''}`
    :'Ainda ninguém lhe deu nota.';
}
function catNotasHTML(v){
  if(!TEM_NOTAS_CAT)return '';
  const x=catNota(v);
  return `<div class="msec">A tua nota</div>
    <div class="stars" id="cn-stars">
      ${[1,2,3,4,5].map(n=>`<button type="button" class="star" onclick="catNotaEstrela(${v.id},${n})" title="${n}"><span>★</span></button>`).join('')}
      <input type="text" id="cn-aval" inputmode="decimal" autocomplete="off" placeholder="—"
        aria-label="A tua nota, de 0 a 5" value="${x&&x.minha!=null?avalFmt(x.minha):''}"
        oninput="catNotaPintar()" onchange="catNotaGuardar(${v.id})" onkeydown="if(event.key==='Enter')this.blur()">
    </div>
    <div class="stars-l" id="cn-stars-l">${CAT_NOTA_VAZIO}</div>
    <div class="note cat-nota-media" id="cn-media">${catNotaMediaHTML(v)}</div>`;
}
function catNotaPintar(){
  const inp=document.getElementById('cn-aval');if(!inp)return;
  const v=catNotaLer(inp.value),ok=v!=null&&!isNaN(v);
  document.querySelectorAll('#cn-stars .star').forEach((b,i)=>{
    const p=ok?Math.min(1,Math.max(0,v-i)):0;
    b.classList.toggle('on',p>=1);
    b.classList.toggle('parte',p>0&&p<1);
    b.style.setProperty('--p',String(p));
  });
  document.getElementById('cn-stars-l').textContent=v==null?CAT_NOTA_VAZIO
    :isNaN(v)?'A nota vai de 0 a 5, com uma casa decimal (4,2).'
    :[estrelas(v),avalFmt(v),AVAL_TXT[Math.round(v)]||''].filter(Boolean).join('  ·  ');
}
function catNotaEstrela(id,n){
  const inp=document.getElementById('cn-aval');if(!inp)return;
  inp.value=(catNotaLer(inp.value)===n)?'':avalFmt(n);
  catNotaPintar();
  catNotaGuardar(id);
}
async function catNotaGuardar(id){
  const v=IDXV[id], inp=document.getElementById('cn-aval');
  if(!v||!inp)return;
  const nota=catNotaLer(inp.value);
  if(Number.isNaN(nota)){toast('A nota vai de 0 a 5, com uma casa decimal (4,2).',1);return;}
  const antes=catNota(v), era=antes&&antes.minha!=null?Number(antes.minha):null;
  if(era===nota)return;
  try{
    const r=await sbRpc('catalogo_nota_definir',{p_catalogo_id:v.cat_id,p_nota:nota});
    CAT_NOTAS[String(v.cat_id)]={media:r.media,n:r.n,minha:r.minha};
    const m=document.getElementById('cn-media');if(m)m.innerHTML=catNotaMediaHTML(v);
    renderFiltrados();
    toast(nota==null?'Nota retirada':'Nota guardada ✓');
  }catch(e){
    toast('Não foi possível guardar a nota: '+(e.message||e),1);
  }
}
/* "Pôr na garrafeira" / "Pôr na wishlist": o formulário do vinho novo de
   sempre, já com a ficha do catálogo nos campos (o nome e a colheita DELE),
   aberto por inteiro para se rever e dizer onde fica a garrafa. Grava-se
   pelo caminho de sempre, e o trigger liga-o a esta linha. */
function catPor(id,modo){
  const v=IDXV[id];
  if(!v||roGuard())return;
  if(modo==='desejo'&&!TEM_DESEJO)return;
  abrirEditarVinho(0,modo);
  const por=(eid,val)=>{const e=document.getElementById(eid);if(e&&val!=null)e.value=val;};
  por('e-nome',v.nome);por('e-ano',v.ano||'');
  if(TIPOS.includes(v.tipo))por('e-tipo',v.tipo);
  iaPreencherForm(Object.assign({},v,{modelo:'catálogo partilhado'}),false);
  formMostrarResto();
}
/* ── VINHO NOVO NO CATÁLOGO (os curadores, 30/09/2026) ──
   Quem o admin do catálogo fez curador (Definições › Utilizadores) cria
   vinhos no Catálogo: o formulário do vinho novo de sempre, sem garrafa,
   gravado pela `winecatalog.criar` — a mesma do "+ Vinho novo" da
   WineCatalog, que recusa se o vinho e a colheita já lá estiverem. */
let FORM_CAT=false;
// O modo do formulário aberto ('', 'desejo', 'catalogo'…): o vinho novo que
// vem da procura grava-se sozinho (`pqGravarNovo`) e tem de saber como.
let FORM_MODO='';
function catPodeCriar(){return !!(EU.curador||EU.admin_catalogo);}
function catNovoVinho(){
  if(!catPodeCriar())return;
  abrirEditarVinho(0,'catalogo');
}
// Os campos do formulário que são FICHA (o que o catálogo guarda) — nunca
// as minhas notas.
const CAT_FICHA_FORM=['tipo','estilo','mencao','classificacao','regiao','sub_regiao','teor','estagio_meses',
  'estagio_texto','beber_de','beber_ate','preco_medio','vivino_nota','vivino_nota_global','vivino_url',
  'imagem_url','harmonizacao','notas_prova','ai_resumo','vivino_avaliacoes','vivino_avaliacoes_global','pais'];
async function catGuardarNovo(){
  const f=lerFormVinho();
  if(!f.nome){toast('Falta o nome do vinho',1);return;}
  const elCor=document.getElementById('e-tipo');
  if(elCor&&!elCor.value){toast('Escolhe a cor do vinho',1);elCor.focus();return;}
  if(f.ano!=null&&(f.ano<1900||f.ano>2100)){toast('Ano fora do razoável',1);return;}
  const campos={};
  CAT_FICHA_FORM.forEach(k=>{if(f[k]!=null&&f[k]!=='')campos[k]=f[k];});
  if(f._castas&&f._castas.length)campos.castas=f._castas.slice().sort((a,b)=>a.localeCompare(b,'pt'));
  if(campos.vivino_url&&!vivinoLink(campos.vivino_url))delete campos.vivino_url;
  const btn=document.getElementById('e-guardar');
  btn.disabled=true;btn.textContent='A criar…';
  try{
    const r=await sbReq('POST','rpc/criar',{p_nome:f.nome,p_produtor:f.produtor||'',p_ano:f.ano,p_campos:campos},
      {'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'});
    _iaExtraNovo=null;FORM_CAT=false;
    fecharModal('modal-edit');
    CAT_VINHOS=null;await catCarregar();renderLista();
    toast('No catálogo ✓');
    if(r&&r.id&&IDXV[-r.id])verVinho(-r.id);
  }catch(e){
    // A `criar` diz qual é a linha quando o vinho já existe.
    toast('Não foi possível criar: '+e.message,1);
    btn.disabled=false;btn.textContent='Criar no catálogo';
  }
}
/* Corrigir um vinho do catálogo (30/09/2026): o Editar de sempre sobre a
   linha, gravado pela `winecatalog.editar` — a mesma do Editar da
   WineCatalog, com a origem do curador (ou do admin). Só vai o que MUDOU no
   formulário (um campo esvaziado apaga-o lá); o nome, o produtor e o ano vão
   numa segunda chamada, com o interruptor da identidade, que recusa se a
   linha passar a ser a mesma que outra — o resto fica gravado na mesma. */
function catIgual(a,b){
  const vz=x=>x==null||x==='';
  if(vz(a)||vz(b))return vz(a)&&vz(b);
  if(typeof a==='number'||typeof b==='number')return Number(a)===Number(b);
  return String(a).trim()===String(b).trim();
}
async function catGuardarEditar(id){
  const v=IDXV[id];if(!v||!(v.id<0)||!catPodeCriar())return;
  const f=lerFormVinho();
  if(!f.nome){toast('Falta o nome do vinho',1);return;}
  if(f.ano!=null&&(f.ano<1900||f.ano>2100)){toast('Ano fora do razoável',1);return;}
  const campos={};
  CAT_FICHA_FORM.forEach(k=>{if(k in f&&!catIgual(f[k],v[k]))campos[k]=f[k]==null?'':f[k];});
  if(campos.vivino_url){
    const l=vivinoLink(campos.vivino_url);
    if(!l){toast('O link do Vivino tem de ser o do vinho (…/w/<número>)',1);return;}
    campos.vivino_url=l;
  }
  const cs=(f._castas||[]).slice().sort((a,b)=>a.localeCompare(b,'pt'));
  const chaveCs=a=>a.map(x=>String(x).toLowerCase()).sort().join('|');
  if(chaveCs(cs)!==chaveCs(v.castas||[]))campos.castas=cs;
  const idt=f.nome!==(v.nome||'')||(f.produtor||'')!==(v.produtor||'')||(f.ano??null)!==(v.ano??null);
  if(!Object.keys(campos).length&&!idt){fecharModal('modal-edit');toast('Nada mudou');return;}
  const WC={'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'};
  const btn=document.getElementById('e-guardar');
  btn.disabled=true;btn.textContent='A guardar…';
  let n=0,erroIdt='';
  try{
    if(Object.keys(campos).length){
      const r=await sbReq('POST','rpc/editar',{p_id:v.cat_id,p_campos:campos},WC);
      n=r?(r.campos||0)+(r.apagados||0):0;
    }
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    btn.disabled=false;btn.textContent='Guardar no catálogo';return;
  }
  if(idt){
    try{await sbReq('POST','rpc/editar',{p_id:v.cat_id,p_campos:{},p_nome:f.nome,p_produtor:f.produtor||'',
      p_ano:f.ano,p_mexer_identidade:true},WC);}
    catch(e){erroIdt=e.message;}
  }
  _iaExtraNovo=null;
  fecharModal('modal-edit');
  CAT_VINHOS=null;
  try{await catCarregar();}catch(_){}
  renderLista();refrescarVinhoAberto();
  if(erroIdt)toast((n?`Corrigido no catálogo (${n} campo${n>1?'s':''}), mas o nome, o produtor e o ano ficaram: `:'O nome, o produtor e o ano ficaram: ')+erroIdt,1);
  else toast('Corrigido no catálogo ✓');
}
/* Um curador grava um vinho da SUA garrafeira: a BD leva o que mudou à
   linha ligada do catálogo (trigger `vinhos_catalogo`, migração 32). Diz-se
   o que aconteceu — sobretudo quando NÃO foi (outra colheita, outra cor, o
   nome novo já é de outra linha). Só depois do "Guardado", e calado se não
   houve nada a levar. */
const CURADOR_MOTIVO={
  sem_ligacao:'este vinho não está ligado a nenhuma linha do catálogo',
  outra_colheita:'está ligado a outra colheita no catálogo',
  outra_cor:'está ligado a um vinho de outra cor no catálogo'
};
async function curadorAviso(vid){
  let r=null;
  try{r=await sbRpc('curador_resultado',{p_vinho_id:vid});}catch(e){return;}
  if(!Array.isArray(r)||!r.length)return;
  const erro=r.find(x=>x.estado!=='ok');
  if(erro){
    toast('Não chegou ao catálogo: '+(CURADOR_MOTIVO[erro.motivo]||erro.erro||'erro desconhecido'),1);
    return;
  }
  const n=new Set();let idt=false;
  r.forEach(x=>{(x.campos||[]).forEach(k=>n.add(k));if(x.identidade)idt=true;});
  const partes=[];
  if(idt)partes.push('o nome');
  if(n.size)partes.push(n.size===1?'1 campo':n.size+' campos');
  if(partes.length){toast('Corrigido também no catálogo: '+partes.join(' e ')+' ✓');CAT_VINHOS=null;}
}
/* Um curador grava um vinho NOVO depois de ver a linha do catálogo no
   "Procurar informação": o que escolheu diferente do que o catálogo lhe
   mostrou (o valor da IA, ou escrito à mão) é uma correção e vai à linha
   ligada. O resto é o de sempre — a `juntar` só enche o que está vazio. */
async function curadorNovo(vid,base){
  try{await sbRpc('curador_levar_novo',{p_vinho_id:vid,p_base:base});}catch(e){return;}
  curadorAviso(vid);
}
async function modoAlternar(){
  if(!modoCat()){
    if(!CAT_VINHOS){
      document.body.classList.add('cat-a-abrir');
      try{await catCarregar();}
      catch(e){toast('Não foi possível abrir o catálogo: '+(e.message||e),1);return;}
      finally{document.body.classList.remove('cat-a-abrir');}
    }
    if(LOTE_SEL_MODO)loteSelCancelar();
    TAB_GARRAFEIRA=tabAtiva;
    MODO='catalogo';
  }else{
    MODO='garrafeira';
  }
  RESUMO_ABERTO=null;RESUMO_DRILL=null;
  // O Local é um filtro da garrafeira: no catálogo cortava tudo.
  if(F.local)F.local='';
  if(FILTRO_CAMPO==='local')FILTRO_CAMPO=null;
  document.body.classList.toggle('cat',modoCat());
  aplicarCabecalho();
  const alvo=modoCat()?'detalhe':(TAB_GARRAFEIRA||'garrafeira');
  tab(alvo,document.querySelector(`.itabs .it[onclick^="tab('${alvo}'"]`));
}

/* ── SUGESTÕES: A WINESELECTION DENTRO DO CATÁLOGO (30/09/2026) ──────
   O dono das apps: "dentro da componente de Catálogo da garrafeira, queria
   igualmente transpor a WineSelection … teríamos um separador de
   Sugestões, onde importaríamos aquela página da WineSelection (que depois
   descontinuarei)". É a página "Sugerir" de lá, tal e qual: as fotos da
   carta, o prato e o orçamento vão à MESMA Edge Function (`sugerir-vinho`,
   do repo WineSelection), e volta a recomendação e a lista da carta, com as
   marcas dos amigos e a pesquisa a sério de até 4 vinhos
   (`verificar-vinhos`). As cartas anteriores são as MINHAS análises.
   - Quem vê o separador: quem tem IA na Garrafeira (`podeUsarIA()`). Do
     lado de lá, a `wineselection.is_allowed()` — que as duas Edge Functions
     perguntam — deixa passar quem tem IA aqui (`garrafeira.plano_ia()`).
   - Os dados continuam no schema `wineselection` (`WS_H`): a app
     WineSelection pode ser desligada sem se perder nada disto.
   - Só no catálogo: é "que vinho peço?", não "o que tenho em casa".
   Os nomes levam `ws`/`WS_` à frente (como lá), e as classes do CSS vivem
   debaixo de `#s-sugestoes`: nada disto pode pisar o resto da app. */
const WS_H={'Accept-Profile':'wineselection','Content-Profile':'wineselection'};
let WS_INIT=false;
function wsAbrir(){
  if(!WS_INIT){
    WS_INIT=true;
    wsRenderImgGrid();
    wsOrcamentoInit();
    wsRetomarPendente();
  }else{
    const t=document.getElementById('ws-orc-track');
    if(t)wsOrcamentoScrollParaIndice(t,_wsOrcamentoIdx,false);
  }
  const h=document.getElementById('ws-hist');
  if(h&&h.open)wsCarregarHistorico();
}
function wsEu(){return String((_sbSession&&_sbSession.user&&_sbSession.user.email)||'').toLowerCase();}

// ── As fotos da carta (mais do que uma, se o menu não couber numa só) ──
let _wsImagens=[]; // [{base64, mime}]
const WS_MAX_IMAGENS=6;
function wsRenderImgGrid(){
  const grid=document.getElementById('ws-img-grid');
  if(!grid)return;
  const thumbs=_wsImagens.map((img,i)=>`
    <div class="img-thumb">
      <img src="data:${img.mime};base64,${img.base64}" alt="">
      <button type="button" class="img-thumb-del" onclick="wsRemoverImagem(${i})" aria-label="Remover">✕</button>
    </div>`).join('');
  const podeAdicionar=_wsImagens.length<WS_MAX_IMAGENS;
  grid.innerHTML=thumbs+(podeAdicionar?`
    <div class="img-add" onclick="document.getElementById('ws-img-input').click()">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      <div>${_wsImagens.length?'Mais uma':'Tirar foto / escolher'}</div>
    </div>`:'');
  const meta=document.getElementById('ws-img-meta');
  if(_wsImagens.length){
    meta.style.display='block';
    meta.innerHTML=`${_wsImagens.length} foto${_wsImagens.length>1?'s':''} · <a href="#" onclick="event.preventDefault();wsLimparImagens()">limpar</a>`;
  }else{
    meta.style.display='none';
  }
  document.getElementById('ws-btn-sugerir').disabled=_wsImagens.length===0||!!_wsPollTimer;
}
function wsRemoverImagem(i){_wsImagens.splice(i,1);wsRenderImgGrid();}
function wsLimparImagens(){_wsImagens=[];wsRenderImgGrid();}

/* ── O orçamento máximo (uma roda que desliza, não uma lista) ──
   Sem valor = "sem limite" (o primeiro). Fica o último escolhido. */
const WS_ORCAMENTO_OPCOES=['','10','15','20','25','30','40','50'];
const WS_ORCAMENTO_KEY='gf_ws_orcamento';
let _wsOrcamentoIdx=0;
function wsOrcamentoValor(){
  const v=WS_ORCAMENTO_OPCOES[_wsOrcamentoIdx];
  return v?parseFloat(v):null;
}
function wsOrcamentoAtualizarUI(){
  document.querySelectorAll('#ws-orc-track .orc-item').forEach((el,i)=>el.classList.toggle('on',i===_wsOrcamentoIdx));
  document.querySelectorAll('#ws-orc-dots .orc-dot').forEach((el,i)=>el.classList.toggle('on',i===_wsOrcamentoIdx));
}
// Os itens são mais estreitos do que a faixa (vê-se os do lado, mais
// claros): mede-se onde está o item e centra-se, seja qual for o CSS.
function wsOrcamentoScrollParaIndice(track,i,animar){
  const item=track.children[i];
  if(!item)return;
  const tr=track.getBoundingClientRect(),ir=item.getBoundingClientRect();
  const alvo=track.scrollLeft+(ir.left-tr.left)-(track.clientWidth-item.clientWidth)/2;
  track.scrollTo({left:alvo,behavior:animar?'smooth':'auto'});
}
function wsOrcamentoDefinirIndice(i,animar){
  i=Math.max(0,Math.min(WS_ORCAMENTO_OPCOES.length-1,i));
  _wsOrcamentoIdx=i;
  try{localStorage.setItem(WS_ORCAMENTO_KEY,WS_ORCAMENTO_OPCOES[i]);}catch(e){}
  wsOrcamentoAtualizarUI();
  const track=document.getElementById('ws-orc-track');
  if(track)wsOrcamentoScrollParaIndice(track,i,animar);
}
function wsOrcamentoMover(delta){wsOrcamentoDefinirIndice(_wsOrcamentoIdx+delta,true);}
function wsOrcamentoInit(){
  const track=document.getElementById('ws-orc-track');
  const dots=document.getElementById('ws-orc-dots');
  if(!track||!dots)return;
  dots.innerHTML=WS_ORCAMENTO_OPCOES.map(()=>'<span class="orc-dot"></span>').join('');
  let saved=null;
  try{saved=localStorage.getItem(WS_ORCAMENTO_KEY);}catch(e){}
  let idx=WS_ORCAMENTO_OPCOES.indexOf(saved);
  if(idx<0)idx=0;
  _wsOrcamentoIdx=idx;
  wsOrcamentoAtualizarUI();
  requestAnimationFrame(()=>wsOrcamentoScrollParaIndice(track,idx,false));
  // Ao largar o dedo, fica o item cujo centro está mais perto do centro.
  let scrollTimer=null;
  track.addEventListener('scroll',()=>{
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>{
      const tr=track.getBoundingClientRect(),centro=tr.left+tr.width/2;
      let melhor=0,menorDist=Infinity;
      Array.from(track.children).forEach((el,i)=>{
        const r=el.getBoundingClientRect();
        const d=Math.abs((r.left+r.width/2)-centro);
        if(d<menorDist){menorDist=d;melhor=i;}
      });
      if(melhor!==_wsOrcamentoIdx)wsOrcamentoDefinirIndice(melhor,false);
    },100);
  });
  window.addEventListener('resize',()=>{if(tabAtiva==='sugestoes')wsOrcamentoScrollParaIndice(track,_wsOrcamentoIdx,false);});
}

// 1280px chega para o Gemini ler a carta; com várias fotos no mesmo pedido,
// mais pequenas é o que não deixa a resposta passar do tempo que o iOS
// tolera. (Não é o `encolherImagem` da app: esse é para os rótulos, a 1000px.)
async function wsProcessarImagem(file){
  const MAX=1280;
  try{
    const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    let{width,height}=bitmap;
    if(width>MAX||height>MAX){
      const scale=MAX/Math.max(width,height);
      width=Math.round(width*scale);height=Math.round(height*scale);
    }
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    canvas.getContext('2d').drawImage(bitmap,0,0,width,height);
    const dataUrl=canvas.toDataURL('image/jpeg',0.82);
    return{base64:dataUrl.split(',')[1],mime:'image/jpeg'};
  }catch(e){
    // um formato que o canvas não decodifica: vai o ficheiro tal qual
    const dataUrl=await new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=()=>res(r.result);r.onerror=rej;
      r.readAsDataURL(file);
    });
    return{base64:dataUrl.split(',')[1],mime:file.type||'image/jpeg'};
  }
}
async function wsImagensEscolhidas(event){
  const files=Array.from(event.target.files||[]);
  event.target.value=''; // deixa escolher o mesmo ficheiro outra vez
  if(!files.length)return;
  const espaco=WS_MAX_IMAGENS-_wsImagens.length;
  const aProcessar=files.slice(0,Math.max(0,espaco));
  const statusEl=document.getElementById('ws-img-status');
  statusEl.style.display='block';statusEl.style.color='var(--mu)';
  let falhas=0;
  for(let i=0;i<aProcessar.length;i++){
    statusEl.textContent=`A preparar a foto ${_wsImagens.length+1}…`;
    try{_wsImagens.push(await wsProcessarImagem(aProcessar[i]));}catch(e){falhas++;}
  }
  if(falhas){
    statusEl.style.color='var(--dg)';
    statusEl.textContent=`Não consegui ler ${falhas>1?'algumas fotos':'uma foto'} — tenta outra vez.`;
  }else if(files.length>aProcessar.length){
    statusEl.style.color='var(--dg)';
    statusEl.textContent=`Só cabem ${WS_MAX_IMAGENS} fotos de cada vez.`;
  }else{
    statusEl.style.display='none';
  }
  wsRenderImgGrid();
}

/* ── Sugerir: a Edge Function responde já, e sonda-se o resultado ──
   A análise (as fotos + o catálogo + a recomendação) pode passar de um
   minuto, e um pedido HTTP à espera disso morre quando o telemóvel bloqueia
   o ecrã. Por isso a função só cria a linha em `wineselection.analises`
   ('pendente') e continua no servidor; daqui sonda-se, e sobrevive a sair
   da app ou a recarregar (`gf_ws_pendente`). */
const WS_PENDENTE_KEY='gf_ws_pendente';
let _wsPollTimer=null, _wsPollInicio=0;
const WS_POLL_INTERVALO_MS=3000;
const WS_POLL_MAX_MS=3*60*1000;
const _wsVerifSel={};          // {analiseId: Set(índice na carta)}
const _wsVerifPolls={};        // {analiseId: {timer, inicio}}

function wsStatus(txt,erro){
  const s=document.getElementById('ws-sugerir-status');
  if(!s)return;
  s.style.display=txt?'block':'none';
  s.style.color=erro?'var(--dg)':'var(--mu)';
  s.textContent=txt||'';
}
async function wsSugerir(){
  if(!_wsImagens.length){toast('Tira primeiro uma foto da carta',1);return;}
  if(!podeUsarIA()){toast('As sugestões usam IA, e a IA não está incluída no teu acesso',1);return;}
  const prato=document.getElementById('ws-prato').value.trim();
  const orcamento=wsOrcamentoValor();
  const btn=document.getElementById('ws-btn-sugerir');
  btn.disabled=true;
  wsStatus('A pedir a análise…');
  document.getElementById('ws-resultado').innerHTML='';
  try{
    const r=await sbFetch(`${SB_URL}/functions/v1/sugerir-vinho`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({imagens:_wsImagens.map(im=>({data:im.base64,mime:im.mime})),prato,orcamento})
    });
    let d={};try{d=await r.json();}catch(_){}
    if(!r.ok||!d.id){
      wsStatus(r.status===403?'As sugestões ainda não estão abertas à tua conta — fala com o admin.'
        :(d.error||('Erro HTTP '+r.status+' — tenta outra vez.')),1);
      btn.disabled=false;
      return;
    }
    try{localStorage.setItem(WS_PENDENTE_KEY,String(d.id));}catch(e){}
    wsIniciarPolling(d.id);
  }catch(e){
    wsStatus('Erro de ligação — tenta outra vez.',1);
    btn.disabled=false;
  }
}
function wsIniciarPolling(id){
  clearTimeout(_wsPollTimer);
  _wsPollInicio=Date.now();
  _wsPollTimer=-1;   // "a sondar", já antes do primeiro tick
  document.getElementById('ws-btn-sugerir').disabled=true;
  wsStatus('A ler a carta e a ver o que já se sabe de cada vinho — podes sair da app, a análise continua…');
  wsPollTick(id);
}
async function wsPollTick(id){
  if(Date.now()-_wsPollInicio>WS_POLL_MAX_MS){
    wsPollTerminar();
    wsStatus('Está a demorar demasiado — tenta outra vez daqui a pouco.',1);
    return;
  }
  try{
    const rows=await sbReq('GET',`analises?id=eq.${encodeURIComponent(id)}&select=id,estado,resultado,erro,prato,verificacao`,undefined,WS_H);
    const row=rows&&rows[0];
    if(!row){wsPollTerminar();wsStatus('');return;}
    if(row.estado==='concluido'){
      wsPollTerminar();
      wsStatus('');
      document.getElementById('ws-resultado').innerHTML=wsResultadoHTML(row.resultado||{},{analiseId:row.id,verificacao:row.verificacao});
      const h=document.getElementById('ws-hist');if(h&&h.open)wsCarregarHistorico();
      return;
    }
    if(row.estado==='erro'){
      wsPollTerminar();
      wsStatus(row.erro||'Não consegui analisar esta carta — tenta outra vez.',1);
      return;
    }
  }catch(e){ /* um soluço de rede: tenta no próximo */ }
  _wsPollTimer=setTimeout(()=>wsPollTick(id),WS_POLL_INTERVALO_MS);
}
function wsPollTerminar(){
  clearTimeout(_wsPollTimer);
  _wsPollTimer=null;
  try{localStorage.removeItem(WS_PENDENTE_KEY);}catch(e){}
  const btn=document.getElementById('ws-btn-sugerir');
  if(btn)btn.disabled=_wsImagens.length===0;
}
// Ao voltar à app (ecrã desbloqueado), sonda já em vez de esperar pelo
// próximo tick — a análise principal e as pesquisas a decorrer.
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible')return;
  if(_wsPollTimer){
    let id=null;
    try{id=localStorage.getItem(WS_PENDENTE_KEY);}catch(e){}
    if(id){clearTimeout(_wsPollTimer);wsPollTick(id);}
  }
  Object.keys(_wsVerifPolls).forEach(aid=>{
    const p=_wsVerifPolls[aid];
    if(p){clearTimeout(p.timer);wsVerifPollTick(aid,p.inicio);}
  });
});
// Uma análise que ficou a meio (recarregou-se a página): retoma-se ao abrir.
function wsRetomarPendente(){
  let id=null;
  try{id=localStorage.getItem(WS_PENDENTE_KEY);}catch(e){}
  if(id)wsIniciarPolling(id);
}

function wsEur(v){return typeof v==='number'&&isFinite(v)?v.toFixed(2).replace('.',',')+' €':'—';}
const WS_PRECO_INFO={
  barato:{cls:'bg-ok',txt:'Preço abaixo do mercado'},
  justo:{cls:'bg-ok',txt:'Preço justo'},
  caro:{cls:'bg-warn',txt:'Um pouco caro'},
  muito_caro:{cls:'bg-bad',txt:'Preço exagerado'},
  desconhecido:{cls:'bg-mu',txt:'Sem dados de preço'}
};
const WS_TIPO_COR={
  Tinto:'#6b1230',Branco:'#e2d08a','Rosé':'#e2879c',Verde:'#9bc26b',
  Espumante:'#c9d9e0',Doce:'#c9932e',Outro:'#c9bfbc'
};
function wsTipoCor(tipo){return WS_TIPO_COR[tipo]||WS_TIPO_COR.Outro;}
function wsLegendaTipos(vinhos){
  const tipos=[...new Set(vinhos.map(v=>v.tipo).filter(Boolean))];
  if(!tipos.length)return '';
  return `<div class="tipo-legenda">${tipos.map(t=>`<span class="tipo-legenda-item"><span class="tipo-dot" style="background:${wsTipoCor(t)}"></span>${esc(t)}</span>`).join('')}</div>`;
}
function wsPontuacaoHTML(pontuacao){
  if(!Array.isArray(pontuacao)||!pontuacao.length)return '';
  return `<div class="pont-row">${pontuacao.map(p=>{
    const valor=typeof p.valor==='number'?p.valor.toFixed(1):'?';
    const corpo=`★ ${valor}/${p.escala||5} <span class="pont-fonte">${esc(p.fonte||'')}</span>`;
    return p.url
      ?`<a class="pont-badge" href="${esc(p.url)}" target="_blank" rel="noopener">${corpo}</a>`
      :`<span class="pont-badge">${corpo}</span>`;
  }).join('')}</div>`;
}
/* Os avisos da conferência feita na Edge Function: o vinho recomendado não
   está na carta que ela leu, ou o preço não bate. Não se esconde a
   sugestão (o emparelhamento é por nome e pode falhar) — quem está à mesa
   tem a carta na mão e confirma num segundo. */
function wsCoerenciaHTML(v){
  const co=v&&v.coerencia;
  if(!co)return '';
  const avisos=[];
  if(co.naCarta===false)avisos.push('Não encontrei este vinho na lista que li da carta — confirma no menu antes de pedires.');
  if(co.precoCartaLido!=null)avisos.push('Na carta li '+wsEur(co.precoCartaLido)+' para este vinho — confirma o preço.');
  if(!avisos.length)return '';
  return `<div class="vinho-alerta">${avisos.map(a=>`<p>⚠️ ${esc(a)}</p>`).join('')}</div>`;
}
function wsPrecoBadgeHTML(v){
  const pi=WS_PRECO_INFO[(v.precoAvaliacao&&v.precoAvaliacao.classificacao)||'desconhecido']||WS_PRECO_INFO.desconhecido;
  return `<div class="preco-badge ${pi.cls}">${pi.txt}${v.precoAvaliacao&&v.precoAvaliacao.faixaMercado?` · ref. ${esc(v.precoAvaliacao.faixaMercado)}`:''}</div>
    ${v.precoAvaliacao&&v.precoAvaliacao.comentario?`<p class="vinho-txt">${esc(v.precoAvaliacao.comentario)}</p>`:''}`;
}
function wsVinhoCardHTML(v,destaque){
  const sub=[v.produtor,v.tipo,v.regiao,v.casta].filter(Boolean).map(esc).join(' · ');
  return `<div class="vinho-card${destaque?' destaque':''}">
    ${destaque?'<div class="vinho-ribbon">🏆 Melhor escolha</div>':''}
    <div class="vinho-head">
      <div>
        <div class="vinho-nome">${esc(v.nome||'Vinho')}</div>
        ${sub?`<div class="vinho-sub">${sub}</div>`:''}
      </div>
      <div class="vinho-preco">${wsEur(v.precoCarta)}</div>
    </div>
    ${wsCoerenciaHTML(v)}
    ${wsPontuacaoHTML(v.pontuacao)}
    ${wsPrecoBadgeHTML(v)}
    ${v.combinacao?`<p class="vinho-txt"><strong>Porque combina:</strong> ${esc(v.combinacao)}</p>`:''}
  </div>`;
}
/* OU SABEMOS OU NÃO SABEMOS: um vinho tem factos (do catálogo, ou de uma
   pesquisa a sério pedida aqui) ou diz "sem dados" — nunca uma estimativa
   de memória com ar de número (a invariante 3 da WineCatalog). As análises
   antigas (sem `versao`) desenham-se pelo caminho antigo, com "—". */
function wsScoreTxt(v){
  if(v.pontuacaoAprox==null||v.pontuacaoOrigem!=='catalogo')return '—';
  return '★ '+Number(v.pontuacaoAprox).toFixed(1)+'<span class="carta-ano">'+esc(v.pontuacaoAno?' '+v.pontuacaoAno:'')+'</span>';
}
function wsNotaDaLista(vinhos){
  const n=(vinhos||[]).filter(v=>v.pontuacaoOrigem==='catalogo').length;
  if(!n)return 'Análise antiga: nenhum destes vinhos tinha sido pesquisado a sério.';
  return '<b>★ '+n+'</b> '+(n===1?'tinha':'tinham')+' nota pesquisada a sério. Os outros (—) não tinham dados.';
}
/* O que cada análise no ecrã tem: a leitura da carta e a última pesquisa
   pedida (`verificacao`). O que se vê é a JUNÇÃO das duas (`wsMesclar`). */
const _wsAnalises={};          // {analiseId: {resultado, verificacao}}
function wsMesclar(res,verif){
  const d=Object.assign({},res||{});
  d.vinhosCarta=(Array.isArray(d.vinhosCarta)?d.vinhosCarta:[]).map(v=>Object.assign({},v));
  if(verif&&!Array.isArray(verif)&&Array.isArray(verif.vinhos)){
    verif.vinhos.forEach(x=>{
      const v=d.vinhosCarta[x.i];
      if(!v)return;
      if(x.conhecido){v.conhecido=x.conhecido;v.precoAvaliacao=x.precoAvaliacao||null;v.naoEncontrado=false;}
      else if(x.naoEncontrado&&!v.conhecido)v.naoEncontrado=true;
      if(typeof x.pesquisaWeb==='boolean')v.pesquisaWeb=x.pesquisaWeb;
    });
    if(verif.recomendacao!=='falhou'){
      d.sugestoes=Array.isArray(verif.sugestoes)?verif.sugestoes:[];
      d.recomendacao=verif.recomendacao;
    }
    d.pesquisar=Array.isArray(verif.pesquisar)?verif.pesquisar:[];
    d.pesquisado=true;
  }
  return d;
}
// Só se oferece para pesquisar o que NÃO se sabe: um vinho já pesquisado
// que ficou sem nota não volta a ter visto (era pagar outra vez pelo mesmo).
function wsPesquisavel(v){return !!v&&!v.conhecido&&!v.naoEncontrado;}
// Ao admin, os que voltaram SEM pesquisa Google levam 🧠, e há a pesquisa
// profunda (o Serper, garantido). A Edge Function volta a confirmar.
function wsDeMemoria(v){return !!v&&v.pesquisaWeb===false;}
function wsResultadoHTML(d,opts){
  opts=opts||{};
  const analiseId=opts.analiseId;
  if(d&&d.versao>=2&&analiseId!=null){
    _wsAnalises[analiseId]={resultado:d,verificacao:opts.verificacao||null};
    setTimeout(()=>wsCarregarMarcas(analiseId),0);
    return `<div class="res-wrap" data-res="${analiseId}">${wsResultadoV2HTML(analiseId)}</div>`;
  }
  return wsResultadoLegadoHTML(d,opts);
}
function wsRedesenhar(analiseId){
  document.querySelectorAll(`#s-sugestoes .res-wrap[data-res="${analiseId}"]`).forEach(el=>{el.innerHTML=wsResultadoV2HTML(analiseId);});
}

/* ── As marcas dos amigos ──
   🍾 na garrafeira de um amigo · ⭐ bebeu-o e deu nota · 💭 na wishlist ·
   🎁 já foi prenda de anos. Os amigos são o grupo FECHADO das Prendas de
   Anos: quem não está lá recebe `null` da `winecatalog.marcas_amigos` e não
   vê marca nenhuma — o portão é do servidor. Pergunta-se sempre que uma
   análise se desenha (o histórico mostra o que os amigos têm HOJE), e se
   falhar a carta aparece sem marcas. */
const _wsMarcas={};            // {analiseId: [marcas|null, …] pela ordem da carta}
async function wsCarregarMarcas(analiseId){
  if(analiseId in _wsMarcas)return;
  const st=_wsAnalises[analiseId];
  const vinhos=st&&st.resultado&&Array.isArray(st.resultado.vinhosCarta)?st.resultado.vinhosCarta:[];
  if(!vinhos.length||!_sbSession)return;
  _wsMarcas[analiseId]=null;
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/rpc/marcas_amigos`,{
      method:'POST',
      headers:sbHeaders({'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'}),
      body:JSON.stringify({p_pedidos:vinhos.map(v=>({nome:String(v.nome||''),produtor:v.produtor||'',ano:Number.isInteger(v.ano)?v.ano:null}))})
    });
    if(!r.ok){delete _wsMarcas[analiseId];return;}
    const d=await r.json();
    if(!Array.isArray(d)||!d.some(Boolean))return;
    _wsMarcas[analiseId]=d;
    wsRedesenhar(analiseId);
  }catch(e){delete _wsMarcas[analiseId];}
}
function wsMarcaDe(analiseId,i){
  const m=_wsMarcas[analiseId];
  return Array.isArray(m)&&Number.isInteger(i)?(m[i]||null):null;
}
function wsMarcasHTML(m){
  if(!m)return '';
  const quem=x=>x.eu?'tu':x.amigo;
  const chip=(t,txt)=>`<span class="am-chip" title="${esc(t)}" data-t="${esc(t)}" onclick="wsAmigoToque(event,this)">${esc(txt)}</span>`;
  const chips=[];
  (m.garrafeiras||[]).forEach(x=>{
    const g=x.garrafas===1?'1 garrafa':x.garrafas+' garrafas';
    const anos=Array.isArray(x.anos)&&x.anos.length?' · '+x.anos.join(', '):'';
    chips.push(chip((x.eu?'Na tua garrafeira':'Na garrafeira de '+x.amigo)+': '+g+anos,`🍾 ${quem(x)}`));
  });
  (m.bebidos||[]).forEach(x=>{
    const nota=Number(x.nota).toFixed(1).replace('.0','').replace('.',',');
    const vezes=x.vezes>1?` (${x.vezes} vezes)`:'';
    chips.push(chip((x.eu?'Bebeste-o e deste-lhe ':x.amigo+' bebeu-o e deu-lhe ')+nota+'/5'+vezes+(x.ultima?' · a última a '+x.ultima:''),`⭐ ${quem(x)} ${nota}/5`));
  });
  (m.wishlist||[]).forEach(x=>{
    chips.push(chip(x.eu?'Na tua wishlist':'Na wishlist de '+x.amigo,`💭 ${quem(x)}`));
  });
  (m.prendas||[]).forEach(x=>{
    const para=x.paraMim?'ti':x.para, de=x.deMim?'ti':x.de;
    chips.push(chip(`Prenda de anos${x.ano?' de '+x.ano:''} para ${para}, comprada por ${de}${x.entregue?'':' — ainda por entregar'}`,
      `🎁 ${x.paraMim?'a ti':x.para}${x.ano?' '+x.ano:''}`));
  });
  return chips.length?`<span class="carta-amigos">${chips.join('')}</span>`:'';
}
// No telemóvel um `title` não abre com um toque: o pormenor vai num toast,
// e o toque não abre/fecha o <details> da sugestão.
function wsAmigoToque(ev,el){
  ev.preventDefault();ev.stopPropagation();
  toast(el.getAttribute('data-t')||'');
}

const WS_REC_TXT={
  'catalogo-falhou':'Não consegui consultar o que já sabemos destes vinhos — tenta outra vez daqui a um minuto antes de pesquisar, para não pagares por uma pesquisa que já foi feita.',
  'sem-conhecidos':'Ainda não conheço nenhum vinho desta carta — e prefiro não adivinhar. Escolhe até 4 na lista para pesquisar a sério (já deixei marcados os que parecem fazer mais sentido para o prato).',
  'falhou':'Não consegui fazer a recomendação agora — mas a lista abaixo tem tudo o que se sabe de cada vinho.',
  'ok':'Dos vinhos que conheço, nenhum combina bem com este pedido. Pesquisa alguns dos outros na lista.',
  'sem-carta':'Não consegui ler vinhos nesta carta — tenta uma foto mais nítida.'
};
function wsResultadoV2HTML(analiseId){
  const st=_wsAnalises[analiseId];
  if(!st)return '';
  const d=wsMesclar(st.resultado,st.verificacao);
  const vinhos=d.vinhosCarta;
  const sug=Array.isArray(d.sugestoes)?d.sugestoes:[];
  let html='';
  if(sug.length){
    html+=`<div class="ws-card-label sug-titulo">A recomendação${sug.length>1?' <em>— toca num vinho para ver o resumo</em>':''}</div>`;
    html+=sug.map((v,k)=>wsSugDetHTML(v,k,sug,analiseId)).join('');
  }else{
    const txt=(d.recomendacao==='sem-carta'&&d.aviso)?d.aviso:(WS_REC_TXT[d.recomendacao]||WS_REC_TXT['sem-conhecidos']);
    html+=`<div class="ws-card"><p class="ws-note">${esc(txt)}</p></div>`;
  }
  if(vinhos.length){
    // Os que a recomendação apontou para pesquisar vêm marcados — só da
    // primeira vez: depois manda quem está à mesa.
    if(!_wsVerifSel[analiseId]){
      _wsVerifSel[analiseId]=new Set((d.pesquisar||[]).filter(i=>wsPesquisavel(vinhos[i])).slice(0,WS_VERIF_MAX));
    }
    const sel=_wsVerifSel[analiseId];
    const nConh=vinhos.filter(v=>v.conhecido).length;
    const pendente=!!_wsVerifPolls[analiseId];
    const memoria=isAdmin()?vinhos.map((v,i)=>wsDeMemoria(v)?i:-1).filter(i=>i>=0):[];
    html+=`<div class="ws-card">
      <div class="ws-card-label">Vinhos da carta (${vinhos.length}) · ${nConh} conhecido${nConh===1?'':'s'}</div>
      <p class="ws-note" style="margin-top:-4px">★ é a nota do Vivino. <b>sem dados</b> quer dizer que ainda não pesquisámos esse vinho — escolhe até ${WS_VERIF_MAX} e eu pesquiso.</p>
      ${wsLegendaTipos(vinhos)}
      ${Array.isArray(_wsMarcas[analiseId])?'<p class="ws-note am-legenda">Dos amigos das Prendas de Anos: 🍾 tem na garrafeira · ⭐ bebeu e deu nota · 💭 está na wishlist · 🎁 já foi prenda. Toca numa marca para ver o pormenor.</p>':''}
      <div class="carta-list">${vinhos.map((v,i)=>wsCartaItemV2HTML(v,i,analiseId,sel)).join('')}</div>
      <div class="verif-bar">
        <button type="button" class="btn ghost" id="ws-btn-verificar-${analiseId}" onclick="wsVerificar(${analiseId})" ${(!sel.size||pendente)?'disabled':''}>🔎 Pesquisar os escolhidos (<span id="ws-verif-count-${analiseId}">${sel.size}</span>)</button>
        ${memoria.length?`<p class="ws-note" style="margin:10px 0 6px">🧠 ${memoria.length===1?'Um vinho voltou':memoria.length+' vinhos voltaram'} sem pesquisa Google — o Gemini respondeu de memória.</p>
        <button type="button" class="btn ghost ws-profunda" id="ws-btn-profunda-${analiseId}" onclick="wsVerificar(${analiseId},true)" ${pendente?'disabled':''}>🔬 Pesquisa profunda (${Math.min(memoria.length,WS_VERIF_MAX)})</button>`:''}
        <div id="ws-verif-status-${analiseId}" class="ws-note" style="${pendente?'':'display:none'}">${pendente?'A pesquisar a sério — pode demorar um pouco…':''}</div>
      </div>
    </div>`;
  }
  return html;
}
/* A caixa resumo: os vinhos conhecidos pela ordem da recomendação, os 2 ou
   3 recomendados com a marca. Só o primeiro vem aberto — à mesa a pergunta
   é "qual?" (`<details>`, sem JavaScript). Um resultado de antes da
   ordenação não tem `recomendado`: aí todas eram recomendações. */
function wsSugDetHTML(v,k,todas,analiseId){
  const antigas=!todas.some(x=>x.recomendado!=null);
  const rec=antigas||!!v.recomendado;
  const sub=[v.produtor,v.tipo,v.regiao,v.casta].filter(Boolean).map(esc).join(' · ');
  const amigos=wsMarcasHTML(wsMarcaDe(analiseId,v.i));
  const p0=Array.isArray(v.pontuacao)&&v.pontuacao[0];
  const nota=p0&&typeof p0.valor==='number'?`★ ${p0.valor.toFixed(1)}`:'<span class="sem-dados">sem nota</span>';
  const marca=k===0&&rec?'<span class="sug-marca topo">🏆 Melhor escolha</span>':rec?'<span class="sug-marca">Recomendado</span>':'';
  return `<details class="vinho-card sug-det${rec?' destaque':''}"${k===0?' open':''}>
    <summary class="sug-sum">
      <span class="sug-pos">${k+1}</span>
      <span class="sug-cab">
        ${marca}
        <span class="vinho-nome">${esc(v.nome||'Vinho')}</span>
        ${sub?`<span class="vinho-sub">${sub}</span>`:''}
        ${amigos}
      </span>
      <span class="sug-dir">
        <span class="vinho-preco">${wsEur(v.precoCarta)}</span>
        <span class="sug-nota">${nota}${v.notaAno?`<span class="carta-ano">${esc(' '+v.notaAno)}</span>`:''}</span>
      </span>
    </summary>
    <div class="sug-corpo">
      ${wsCoerenciaHTML(v)}
      ${wsPontuacaoHTML(v.pontuacao)}
      ${wsPrecoBadgeHTML(v)}
      ${v.combinacao?`<p class="vinho-txt"><strong>Porquê:</strong> ${esc(v.combinacao)}</p>`:''}
    </div>
  </details>`;
}
function wsCartaItemV2HTML(v,i,analiseId,sel){
  const k=v.conhecido;
  const tipo=v.tipo||(k&&k.tipo)||null;
  const podePesquisar=wsPesquisavel(v);
  const sub=[v.produtor||(k&&k.produtor),v.ano,k&&Array.isArray(k.castas)&&k.castas.length?k.castas.slice(0,3).join(', '):null].filter(Boolean).map(esc).join(' · ');
  let score;
  if(k&&k.nota!=null){
    const corpo='★ '+Number(k.nota).toFixed(1)+'<span class="carta-ano">'+esc(k.notaAno?' '+k.notaAno:'')+'</span>';
    score=k.notaUrl?`<a class="carta-score conhecida" href="${esc(k.notaUrl)}" target="_blank" rel="noopener">${corpo}</a>`:`<span class="carta-score conhecida">${corpo}</span>`;
  }else if(k){
    score='<span class="carta-score">sem nota</span>';
  }else if(v.naoEncontrado){
    score='<span class="carta-score" title="Pesquisado a sério, sem resultados fiáveis">não encontrado</span>';
  }else{
    score='<span class="carta-score sem-dados">sem dados</span>';
  }
  const cls=(v.precoAvaliacao&&v.precoAvaliacao.classificacao)||'';
  const pi=WS_PRECO_INFO[cls];
  const precoTit=pi&&cls!=='desconhecido'?`${pi.txt}${v.precoAvaliacao.faixaMercado?' · '+v.precoAvaliacao.faixaMercado:''}`:'';
  return `<div class="carta-item">
    ${podePesquisar?`<input type="checkbox" class="carta-check" data-analise="${analiseId}" data-i="${i}" ${sel.has(i)?'checked':''} onchange="wsVerifToggle(this)">`:'<span class="carta-check-vazio"></span>'}
    <span class="tipo-dot" style="background:${wsTipoCor(tipo)}" title="${esc(tipo||'Cor desconhecida')}"></span>
    <span class="carta-nome">${esc(v.nome||'')}${isAdmin()&&wsDeMemoria(v)?' <span class="carta-memoria" title="Respondido de memória — sem pesquisa Google">🧠</span>':''}${sub?`<span class="carta-sub">${sub}</span>`:''}${wsMarcasHTML(wsMarcaDe(analiseId,i))}</span>
    ${score}
    <span class="carta-preco${cls&&cls!=='desconhecido'?' preco-'+cls:''}"${precoTit?` title="${esc(precoTit)}"`:''}>${wsEur(v.preco)}</span>
  </div>`;
}
// O resultado de antes da versão 2, como era (só no histórico).
function wsResultadoLegadoHTML(d,opts){
  const sug=Array.isArray(d.sugestoes)?d.sugestoes:[];
  if(!sug.length){
    return `<div class="ws-card"><p class="ws-note">${esc(d.aviso||'Não encontrei sugestões claras nesta carta — tenta uma foto mais nítida.')}</p></div>`;
  }
  let html=sug.map((v,i)=>wsVinhoCardHTML(v,i===0)).join('');
  if(Array.isArray(d.vinhosCarta)&&d.vinhosCarta.length){
    html+=`<div class="ws-card">
      <div class="ws-card-label">Vinhos lidos na carta (${d.vinhosCarta.length})</div>
      <p class="ws-note" style="margin-top:-4px">${wsNotaDaLista(d.vinhosCarta)}</p>
      ${wsLegendaTipos(d.vinhosCarta)}
      <div class="carta-list">${d.vinhosCarta.map(v=>`<div class="carta-item">
        <span class="carta-check-vazio"></span>
        <span class="tipo-dot" style="background:${wsTipoCor(v.tipo)}" title="${esc(v.tipo||'Cor desconhecida')}"></span>
        <span class="carta-nome">${esc(v.nome||'')}</span>
        <span class="carta-score${v.pontuacaoOrigem==='catalogo'?' conhecida':''}">${wsScoreTxt(v)}</span>
        <span class="carta-preco">${wsEur(v.preco)}</span>
      </div>`).join('')}</div>
    </div>`;
  }
  if(Array.isArray(opts.verificacao)&&opts.verificacao.length){
    html+=`<div class="ws-card-label" style="margin-top:14px">Verificação pedida</div>${opts.verificacao.map(wsVerifCardHTML).join('')}`;
  }
  if(Array.isArray(d.fontes)&&d.fontes.length){
    html+=`<div class="ws-fontes">Fontes: ${d.fontes.map(f=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}</div>`;
  }
  return html;
}

/* ── A pesquisa a sério (até 4 vinhos escolhidos na lista) ──
   A Edge Function `verificar-vinhos` recebe os ÍNDICES dos vinhos na carta
   lida, pesquisa-os, volta a recomendar sobre a carta inteira e guarda no
   catálogo o que encontrou. Mexe na mesma linha de `analises`, com o mesmo
   pedido-e-sondagem. */
const WS_VERIF_MAX=4;
function wsVerifToggle(el){
  const aid=el.dataset.analise,i=parseInt(el.dataset.i,10);
  if(!_wsVerifSel[aid])_wsVerifSel[aid]=new Set();
  const sel=_wsVerifSel[aid];
  if(el.checked){
    if(sel.size>=WS_VERIF_MAX){el.checked=false;toast('Escolhe no máximo '+WS_VERIF_MAX+' vinhos',1);return;}
    sel.add(i);
  }else{
    sel.delete(i);
  }
  // A mesma análise pode estar desenhada em dois sítios (a de agora e o
  // histórico): os vistos e o contador mudam nos dois.
  document.querySelectorAll(`.carta-check[data-analise="${aid}"][data-i="${i}"]`).forEach(c=>{c.checked=sel.has(i);});
  document.querySelectorAll('#ws-verif-count-'+aid).forEach(c=>{c.textContent=sel.size;});
  document.querySelectorAll('#ws-btn-verificar-'+aid).forEach(b=>{b.disabled=sel.size===0||!!_wsVerifPolls[aid];});
}
function wsVerifStatus(analiseId,txt,erro){
  document.querySelectorAll('#ws-verif-status-'+analiseId).forEach(s=>{
    s.style.display=txt?'block':'none';
    s.style.color=erro?'var(--dg)':'var(--mu)';
    s.textContent=txt||'';
  });
}
function wsVerifBotoes(analiseId,desligar){
  const sel=_wsVerifSel[analiseId];
  document.querySelectorAll('#ws-btn-verificar-'+analiseId).forEach(b=>{b.disabled=desligar||!sel||!sel.size;});
  document.querySelectorAll('#ws-btn-profunda-'+analiseId).forEach(b=>{b.disabled=!!desligar;});
}
async function wsVerificar(analiseId,profunda){
  let indices;
  if(profunda){
    const st=_wsAnalises[analiseId];
    const vinhos=st?wsMesclar(st.resultado,st.verificacao).vinhosCarta:[];
    indices=vinhos.map((v,i)=>wsDeMemoria(v)?i:-1).filter(i=>i>=0).slice(0,WS_VERIF_MAX);
  }else{
    const sel=_wsVerifSel[analiseId];
    indices=sel?[...sel]:[];
  }
  if(!indices.length)return;
  wsVerifBotoes(analiseId,true);
  wsVerifStatus(analiseId,profunda?'Pesquisa profunda — a pesquisar no Google…':'A pesquisar a sério — pode demorar um pouco…');
  try{
    const r=await sbFetch(`${SB_URL}/functions/v1/verificar-vinhos`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify(profunda?{analiseId,indices,profunda:true}:{analiseId,indices})
    });
    let d={};try{d=await r.json();}catch(_){}
    if(!r.ok){
      wsVerifStatus(analiseId,d.error||('Erro HTTP '+r.status+' — tenta outra vez.'),1);
      wsVerifBotoes(analiseId,false);
      return;
    }
    wsVerifIniciarPolling(analiseId);
  }catch(e){
    wsVerifStatus(analiseId,'Erro de ligação — tenta outra vez.',1);
    wsVerifBotoes(analiseId,false);
  }
}
function wsVerifIniciarPolling(analiseId){
  const inicio=Date.now();
  const p=_wsVerifPolls[analiseId]||{};
  clearTimeout(p.timer);
  _wsVerifPolls[analiseId]={timer:null,inicio};
  wsVerifPollTick(analiseId,inicio);
}
async function wsVerifPollTick(analiseId,inicio){
  if(Date.now()-inicio>WS_POLL_MAX_MS){
    delete _wsVerifPolls[analiseId];
    wsVerifStatus(analiseId,'Está a demorar demasiado — tenta outra vez.',1);
    wsVerifBotoes(analiseId,false);
    return;
  }
  try{
    const rows=await sbReq('GET',`analises?id=eq.${encodeURIComponent(analiseId)}&select=id,verificacao_estado,verificacao,verificacao_erro`,undefined,WS_H);
    const row=rows&&rows[0];
    if(row&&row.verificacao_estado==='concluido'){
      delete _wsVerifPolls[analiseId];
      wsVerifConcluida(analiseId,row.verificacao);
      return;
    }
    if(row&&row.verificacao_estado==='erro'){
      delete _wsVerifPolls[analiseId];
      wsVerifStatus(analiseId,row.verificacao_erro||'Não consegui pesquisar — tenta outra vez.',1);
      wsVerifBotoes(analiseId,false);
      return;
    }
  }catch(e){ /* um soluço de rede: tenta no próximo */ }
  if(_wsVerifPolls[analiseId]){
    _wsVerifPolls[analiseId].timer=setTimeout(()=>wsVerifPollTick(analiseId,inicio),WS_POLL_INTERVALO_MS);
  }
}
// A pesquisa voltou: a lista e a recomendação redesenham-se com o que se
// sabe agora, e os vistos limpam-se.
function wsVerifConcluida(analiseId,verificacao){
  const st=_wsAnalises[analiseId];
  if(!st||!verificacao||Array.isArray(verificacao)){
    wsVerifStatus(analiseId,'');
    wsVerifBotoes(analiseId,false);
    return;
  }
  st.verificacao=verificacao;
  delete _wsVerifSel[analiseId];
  wsRedesenhar(analiseId);
  const n=(verificacao.vinhos||[]).filter(x=>x.naoEncontrado).length;
  const mem=isAdmin()?(verificacao.vinhos||[]).filter(x=>x.pesquisaWeb===false).length:0;
  toast(mem?`Pesquisa feita — ${mem} de memória, sem Google`:n?`Pesquisa feita — ${n} sem dados fiáveis`:'Pesquisa feita ✓');
  // o que se pesquisou ficou no catálogo: da próxima vez que se abrir,
  // relê-se
  CAT_VINHOS=null;
  if(modoCat())catCarregar().then(()=>{if(tabAtiva==='detalhe')renderFiltrados();}).catch(()=>{});
}
// Uma verificação antiga que volta num instante parece uma resposta a
// fingir — não é: já tinha sido pesquisada, e o catálogo guardou-a.
function wsVerifOrigemHTML(v){
  if(v.origem!=='catalogo')return '';
  const d=v.origemEm?new Date(v.origemEm):null;
  const quando=(d&&!isNaN(d))?d.toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'}):'';
  const ano=v.origemAno?(' · colheita de '+v.origemAno):'';
  return `<div class="verif-origem">✓ Já pesquisado${quando?' em '+esc(quando):''}${esc(ano)} — não foi preciso pesquisar outra vez.</div>`;
}
function wsVerifCardHTML(v){
  return `<div class="vinho-card verif-card">
    <div class="vinho-nome">${esc(v.nome||'')}</div>
    ${wsVerifOrigemHTML(v)}
    ${wsPontuacaoHTML(v.pontuacao)}
    ${wsPrecoBadgeHTML(v)}
  </div>`;
}

/* ── As cartas anteriores (as MINHAS análises) ──
   A linha nasce em `analises` quando se pede, e fecha-se no sítio quando a
   análise acaba — o histórico é essa tabela, com as que falharam ou ainda
   estão a correr. Só as minhas, mesmo ao admin (que lá as vê todas). Cada
   carta só se desenha quando se abre: desenhada, pergunta pelas marcas dos
   amigos, e eram trinta perguntas de uma vez para ninguém as ver. */
const _wsHist={};              // {id: linha de `analises`}
async function wsCarregarHistorico(){
  const box=document.getElementById('ws-historico');
  if(!box)return;
  box.innerHTML='<p class="ws-note">A carregar…</p>';
  try{
    const rows=await sbReq('GET',`analises?user_email=eq.${encodeURIComponent(wsEu())}&select=id,prato,estado,resultado,erro,criado_em,verificacao&order=criado_em.desc&limit=30`,undefined,WS_H);
    if(!rows||!rows.length){box.innerHTML='<p class="ws-note">Ainda não pediste nenhuma sugestão.</p>';return;}
    rows.forEach(r=>{_wsHist[r.id]=r;});
    box.innerHTML=rows.map(wsHistItemHTML).join('');
  }catch(e){box.innerHTML='<p class="ws-note">Não foi possível carregar as cartas anteriores.</p>';}
}
function wsHistItemHTML(r){
  // A recomendação que conta é a mais recente: a de depois da pesquisa.
  const sug=(r.resultado&&r.resultado.versao>=2)
    ?(wsMesclar(r.resultado,r.verificacao).sugestoes||[])
    :((r.resultado&&Array.isArray(r.resultado.sugestoes))?r.resultado.sugestoes:[]);
  const top=sug[0]||null;
  const data=new Date(r.criado_em);
  const dataFmt=isNaN(data)?'':data.toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'});
  const topTxt=r.estado==='pendente'?'⏳ a analisar…':r.estado==='erro'?'⚠️ falhou':(top?('🍷 '+esc(top.nome)):'sem sugestões');
  return `<div class="hist-item">
    <div class="hist-head" onclick="wsToggleHist(${r.id})">
      <div>
        <div class="hist-prato">${esc(r.prato||'(sem prato)')}</div>
        <div class="hist-top">${topTxt}</div>
      </div>
      <div class="hist-data">${dataFmt}</div>
    </div>
    <div class="hist-body" id="ws-hist-body-${r.id}" style="display:none"></div>
  </div>`;
}
function wsHistCorpoHTML(r){
  if(r.estado==='concluido')return wsResultadoHTML(r.resultado||{},{analiseId:r.id,verificacao:r.verificacao});
  if(r.estado==='erro')return `<p class="ws-note" style="color:var(--dg)">${esc(r.erro||'Falhou — tenta outra vez.')}</p>`;
  return '<p class="ws-note">Ainda a analisar — volta a abrir daqui a pouco.</p>';
}
function wsToggleHist(id){
  const el=document.getElementById('ws-hist-body-'+id);
  if(!el)return;
  const abrir=el.style.display==='none';
  if(abrir&&!el.dataset.pronto&&_wsHist[id]){el.innerHTML=wsHistCorpoHTML(_wsHist[id]);el.dataset.pronto='1';}
  el.style.display=abrir?'block':'none';
}

/* ── NAVEGAÇÃO ─────────────────────────────────────────────────────── */
let tabAtiva='garrafeira';
const ORDEM_TABS=['garrafeira','detalhe','locais','consumidos','desejos','sugestoes','cfg'];
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
  if(nome==='desejos')renderDesejos();
  if(nome==='sugestoes')wsAbrir();
  if(nome==='cfg')renderCfg();
  fabSincronizar();
  window.scrollTo({top:0,behavior:'instant'});
}
function restaurarTab(){
  let t=null;try{t=localStorage.getItem('gf_tab');}catch(e){}
  // As Sugestões são do catálogo, e a app abre sempre na garrafeira.
  if(!t||t==='garrafeira'||t==='sugestoes')return;
  if(t==='desejos'&&!TEM_DESEJO)return;   // a migração 15 ainda não correu
  if(t==='locais'&&!temLocaisDesenhados())return;
  if(t==='consumidos'&&!temConsumidos())return;
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
    // ANTES da barra da lista, não antes dos grupos: escreve-se o que se
    // procura e só depois se decide como arrumar o que sobrou.
    const box=document.getElementById('det-barra');
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
const RESUMO_NOME={mono:'Monocasta',regiao:'Regiões',casta:'Castas',valor:'Valor',falta:'A completar',
  cor:'Cores',regiao_tinto:'Tintos por região',regiao_branco:'Brancos por região',
  casta_tinto:'Tintos por casta',casta_branco:'Brancos por casta'};
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
/* ── O PREÇO QUE CONTA ─────────────────────────────────────────────
   Um vinho tem até dois tipos de preço: o que as LOJAS pedem hoje (lido do
   catálogo partilhado, `precos_lojas` — nunca copiado para cá, que ficava
   velho no dia a seguir) e o PREÇO MÉDIO da ficha (a IA ou quem o
   escreveu). O que conta — no cartão, no valor da garrafeira, no filtro
   por preço, nos PDFs — é UM só, `precoPrincipal`, e diz sempre de onde
   veio.

   A ordem é das lojas que vendem a garrafa a sério para o agregador:
   Garrafeira Nacional → Granvine → Vinha → Vivino. Mas uma loja vende a
   colheita que tem AGORA, e raramente é a minha — por isso a colheita
   pesa antes da loja:
     1. uma loja, da MINHA colheita;
     2. o Vivino, da minha colheita;
     3. uma loja, de OUTRA colheita (marcado como tal);
     4. o Vivino sem colheita conhecida (o Vivino quase nunca a diz);
     5. o preço médio da ficha.
   Num vinho SEM ano (o normal na wishlist) qualquer colheita é a minha.
   Uma loja que não diga a colheita não conta como a minha — conta como
   outra: um preço que ninguém consegue datar não passa à frente de um
   que se sabe de que ano é. Lojas que não estejam em `LOJAS` aparecem no
   detalhe mas nunca contam. */
let PRECOS_LOJA={};   // vinho_id -> [{loja,preco,url,nome,colheita,em}]
let PROD_COMPLETO={}; // produtor oficial -> nome por extenso (catálogo)
const LOJAS=[
  {k:'garrafeira_nacional',nome:'Garrafeira Nacional',curto:'G. Nacional'},
  {k:'granvine',nome:'Granvine',curto:'Granvine'},
  {k:'vinha',nome:'Vinha',curto:'Vinha'},
  {k:'vivino',nome:'Vivino',curto:'Vivino'}
];
function lojaInfo(k){return LOJAS.find(l=>l.k===k)||{k,nome:k,curto:k};}
function lojaOrdem(k){const i=LOJAS.findIndex(l=>l.k===k);return i<0?99:i;}
/* Os preços acham-se pelo NOME e pelo PRODUTOR (a chave do catálogo) e só
   se liam no `carregarGarrafeira`. Um vinho acabado de gravar — ou com o
   nome mudado — ficava com o preço de referência e sem loja nenhuma até
   alguém recarregar a app, com o catálogo a ter o preço da Garrafeira
   Nacional à espera (26/09/2026, o Dona Sancha na wishlist do Barrona). Por
   isso relê-se depois de gravar: é um pedido só, pela garrafeira toda. Não
   se espera por ele — o cartão acerta-se quando a resposta chegar. */
async function recarregarPrecosLoja(){
  const ga=GA_ID;
  if(!ga)return;
  let pl=null;
  try{pl=await sbRpc('precos_lojas',{p_garrafeira_id:ga});}catch(e){return;}
  if(ga!==GA_ID||!pl||typeof pl!=='object')return;   // trocou-se de garrafeira entretanto
  PRECOS_LOJA=pl;
  renderLista();refrescarVinhoAberto();
}
// A colheita do preço: a que a loja diz, ou o `?year=` de um link do Vivino.
function colheitaPreco(p){
  if(p.colheita)return Number(p.colheita);
  const m=/[?&]year=(\d{4})\b/.exec(p.url||'');
  return m?Number(m[1]):null;
}
/* UM PREÇO DESALINHADO NÃO CONTA. O script que recolhe os preços acerta
   quase sempre, mas quando falha é na PÁGINA (outro vinho da mesma casa,
   meia garrafa): o Casa de Saima Garrafeira apareceu a 8,49 € no Vivino com
   as duas lojas a pedirem 63 € e 69 €. Uma colheita diferente mexe no preço
   uns 10–20%, não o divide por sete. Por isso um preço que fique abaixo de
   metade ou acima do dobro da MEDIANA dos outros (as outras lojas e o
   preço médio da ficha) é marcado `duvidoso`: aparece no detalhe, riscado,
   e nunca é o que conta. Sem mais nenhum preço com que comparar não há
   como saber, e conta. */
function mediana(xs){
  const a=[...xs].sort((x,y)=>x-y), n=a.length;
  return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null;
}
function precosLojaDe(v){
  const ps=((v&&(v.id<0?CAT_PRECOS[v.id]:PRECOS_LOJA[v.id]))||[]).filter(p=>p&&Number(p.preco)>0)
    .map(p=>({...p,preco:Number(p.preco),colheita:colheitaPreco(p)}))
    .sort((a,b)=>lojaOrdem(a.loja)-lojaOrdem(b.loja)||(b.colheita||0)-(a.colheita||0));
  ps.forEach((p,i)=>{
    const ref=mediana(ps.filter((_,j)=>j!==i).map(q=>q.preco)
      .concat(v.preco_medio!=null?[Number(v.preco_medio)]:[]));
    p.duvidoso=ref!=null&&(p.preco<ref/2||p.preco>ref*2);
  });
  return ps;
}
function precoPrincipal(v){
  if(!v)return null;
  const ps=precosLojaDe(v).filter(p=>lojaOrdem(p.loja)<99&&!p.duvidoso);
  const minha=p=>v.ano==null||(p.colheita!=null&&p.colheita===Number(v.ano));
  const loja=p=>p.loja!=='vivino', viv=p=>p.loja==='vivino';
  const p=ps.find(p=>loja(p)&&minha(p))||ps.find(p=>viv(p)&&minha(p))
        ||ps.find(loja)||ps.find(viv);
  if(p)return {preco:p.preco,loja:p.loja,colheita:p.colheita,outra:!minha(p),url:p.url,em:p.em};
  return v.preco_medio!=null?{preco:Number(v.preco_medio),loja:null}:null;
}
function precoVinho(v){const p=precoPrincipal(v);return p?p.preco:null;}

/* A NOTA DO VIVINO SÃO DUAS (migração 22, 26/09/2026): a da COLHEITA
   (`vivino_nota`/`vivino_avaliacoes` — o Vivino com `?year=`) e a de TODAS
   as colheitas (`vivino_nota_global`/`vivino_avaliacoes_global`). Um 4,5 com
   40 avaliações de 2019 diz menos do que o 4,2 de 5000 do vinho todo. A
   que CONTA — no crachá do cartão e da grelha, na página do vinho, na
   ordenação, no filtro por Vivino, no "A completar" e nos PDFs — é uma só,
   e sai sempre daqui (nunca `v.vivino_nota` à mão nesses sítios):
   · a da colheita, se tiver pelo menos 100 avaliações;
   · senão a que tiver MAIS avaliações — quase sempre a de todas as
     colheitas (o vinho todo não pode ter menos do que um dos anos dele); em
     empate, a de todas. É isto que resolve o caso de nenhuma chegar às 100.
   Uma nota sem contagem conta como zero avaliações; havendo só uma, é essa.
   Nunca uma média das duas: era um número que ninguém encontra no Vivino.
   A MESMA regra do `wcNotaVivino` da WineCatalog — mexer numa é mexer na
   outra, no mesmo dia. */
const VIVINO_MIN_AVAL=100;
function notaVivino(v){
  if(!v)return null;
  const n=x=>{if(x==null||x==='')return null;const y=Number(x);return isFinite(y)?y:null;};
  const c=n(v.vivino_nota)!=null?{nota:n(v.vivino_nota),aval:n(v.vivino_avaliacoes),de:'colheita'}:null;
  const g=n(v.vivino_nota_global)!=null?{nota:n(v.vivino_nota_global),aval:n(v.vivino_avaliacoes_global),de:'global'}:null;
  if(!c||!g)return c||g;
  if((c.aval||0)>=VIVINO_MIN_AVAL)return c;
  return (c.aval||0)>(g.aval||0)?c:g;
}
function notaVivinoNum(v){const x=notaVivino(v);return x?x.nota:null;}
/* Na PDF da wishlist: a mesma, com "(todas)" quando é a de todas as colheitas. */
function vivinoPDF(v){
  const x=notaVivino(v);
  return x?esc('★ '+x.nota.toFixed(1)+(x.de==='global'?' (todas)':'')):'';
}
/* Na página do vinho: a que conta primeiro e, havendo as duas, a outra ao
   lado — cada uma dita pelo nome ("2019" ou "todas as colheitas"). Com uma
   só, fica como sempre foi. */
function notaVivinoHeroHTML(v){
  const x=notaVivino(v);
  if(!x)return '';
  const duas=v.vivino_nota!=null&&v.vivino_nota_global!=null;
  const pill=y=>`<span class="mhero-n" title="${esc(notaVivinoTitulo(y,v.ano))}">★ ${y.nota.toFixed(2)} Vivino${
    y.aval?` · ${y.aval}`:''}${y.de==='global'?' · todas as colheitas':duas&&v.ano?' · '+v.ano:''}</span>`;
  if(!duas)return pill(x);
  const outra=x.de==='global'?notaVivino({...v,vivino_nota_global:null}):notaVivino({...v,vivino_nota:null});
  return pill(x)+(outra?pill(outra):'');
}
/* O porquê, para o `title` do crachá. */
function notaVivinoTitulo(x,ano){
  if(!x)return '';
  const q=x.aval!=null?` · ${x.aval} avaliações`:'';
  return x.de==='global'?`Nota do Vivino de todas as colheitas${q}`
    :`Nota do Vivino${ano?' da colheita '+ano:''}${q}`;
}
/* O crachá: a estrela e, quando é a de todas as colheitas MAS há também
   uma da colheita (só perdeu por não chegar às 100 avaliações), a palavra
   "todas" — é o que distingue as duas. Sem nota de colheita nenhuma, "todas"
   não diz nada a ninguém: só há uma nota, e é essa. A da colheita não leva
   nada — até 26/09/2026 era a única, e muita veio de pesquisas que não
   sabiam a colheita; chamar-lhe "da colheita" no cartão era dizer o que não
   se sabe. */
function notaVivinoBadge(v){
  const x=notaVivino(v);
  if(!x)return '';
  const mostraTodas=x.de==='global'&&v.vivino_nota!=null&&v.vivino_nota!=='';
  return `<span class="bdg viv" title="${esc(notaVivinoTitulo(x,v.ano))}">★ ${x.nota.toFixed(1)}${
    mostraTodas?' <small class="viv-de">todas</small>':''}</span>`;
}
// De onde veio, em poucas palavras: "Granvine", "Granvine · 2019" (outra
// colheita), "Vivino · média" (sem colheita, o Vivino dá a média das
// colheitas), "preço médio".
function precoFonteTxt(p,curto){
  if(!p)return '';
  if(!p.loja)return 'preço de referência';
  const l=lojaInfo(p.loja);
  return (curto?l.curto:l.nome)+(p.outra?(p.colheita?' · '+p.colheita:(curto?' · média':' · média das colheitas')):'');
}

// O crachá do cartão: o preço e, em pequeno, de onde veio — só quando não
// é o preço médio, que é o que o cartão sempre mostrou.
function precoBadge(v){
  const p=precoPrincipal(v);
  if(!p)return '';
  const f=p.loja?precoFonteTxt(p,true):'';
  return `<span class="bdg preco"${p.loja?` title="${esc(precoFonteTxt(p))}"`:''}>${esc(eur0(p.preco))}${f?`<small>· ${esc(f)}</small>`:''}</span>`;
}
function precoPDF(v){
  const p=precoPrincipal(v);
  if(!p)return '';
  return esc(eur(p.preco))+(p.loja?`<span class="pfonte">${esc(precoFonteTxt(p,true))}</span>`:'');
}
/* A lista das lojas na página do vinho: TODAS, com o link, a colheita e a
   data da recolha — as de outra colheita também, que é informação, só não
   é o preço deste vinho. A que conta leva, à frente do nome, uma nota
   pequena "(preço de referência)" — e mais nada: a regra de qual conta
   (`precoPrincipal`) não se explica aqui, ninguém precisa de a ler. */
function precosLojaHTML(v){
  const ps=precosLojaDe(v);
  if(!ps.length)return '';
  const pp=precoPrincipal(v);
  return `<div class="msec">Preços nas lojas</div>
    <div class="mprecos">${ps.map(p=>{
      const conta=pp&&pp.loja===p.loja&&pp.preco===p.preco&&pp.colheita===p.colheita&&pp.url===p.url;
      const outra=v.ano!=null&&p.colheita!=null&&p.colheita!==Number(v.ano);
      const meta=p.duvidoso?'muito diferente dos outros — provavelmente não é deste vinho'
        :[p.colheita?(outra?'colheita '+p.colheita:'a tua colheita')
                    :(p.loja==='vivino'?'média das colheitas':''),
          p.em?'visto a '+dataPT(p.em):''].filter(Boolean).join(' · ');
      const nome=esc(lojaInfo(p.loja).nome);
      return `<div class="mpreco${conta?' conta':''}${outra?' outra':''}${p.duvidoso?' duvidoso':''}">
        <div class="mp-l">${p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener">${nome}</a>`:nome}${conta?' <span class="mp-ref">(preço de referência)</span>':''}
          <i>${esc(meta)}</i></div>
        <div class="mp-v">${esc(eur(p.preco))}</div>
      </div>`;}).join('')}
    </div>`;
}

/* O VALOR da garrafeira é uma ESTIMATIVA e diz-se isso: vale o que se
   pagou (`preco_compra`) quando se sabe, e o preço que conta do vinho
   (`precoPrincipal`) quando não se sabe. Garrafas sem nenhum dos dois não
   contam — inventar um preço para elas era pôr no cartão um número que
   ninguém podia conferir. */
function valorGarrafa(g){
  if(g.preco_compra!=null)return Number(g.preco_compra);
  return precoVinho(IDXV[g.vinho_id]);
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
  {k:'Sem preço',           tem:v=>precoVinho(v)!=null},
  {k:'Sem classificação',   tem:v=>!!v.classificacao},
  {k:'Sem nota Vivino',     tem:v=>notaVivinoNum(v)!=null},
  {k:'Sem informação de harmonização',       tem:v=>!!v.harmonizacao},
  // Sem colheita não há janela de consumo (ver `IA_JANELA`) — não é falta.
  {k:'Sem informação de intervalo de consumo',tem:v=>v.ano==null||v.beber_de!=null||v.beber_ate!=null}
];
function faltasDe(v){return FALTAS.filter(f=>!f.tem(v)).map(f=>f.k);}

function renderResumo(){
  const box=document.getElementById('resumo-cards');
  if(!box)return;
  // No catálogo (o título trocado) é o mesmo Resumo sobre o catálogo
  // inteiro, com as diferenças que o dono pediu (30/09/2026): sem valor
  // estimado, o número de tintos e de brancos, e os quatro "Top" por cor em
  // vez das duas preferidas.
  const cat=modoCat();
  const comStock=cat?(CAT_VINHOS||[]):db.vinhos.filter(v=>stockDe(v.id)>0);
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
  // No catálogo: os tintos e os brancos, e o topo de cada um.
  const daCor=c=>comStock.filter(v=>chave(v.tipo||'')===c);
  const tintos=cat?daCor('tinto'):[], brancos=cat?daCor('branco'):[];
  const RC={};   // painéis por cor: 'regiao_tinto' → {lista, rows, casta?}
  if(cat){
    [['tinto',tintos,'Tintos'],['branco',brancos,'Brancos']].forEach(([c,lista,nome])=>{
      const rr=contarPor(lista,v=>[v.regiao||'Sem região'])
        .sort((a,b)=>(a.nome==='Sem região')-(b.nome==='Sem região')||b.n-a.n||a.nome.localeCompare(b.nome,'pt'));
      const cr=contarPor(lista,v=>v.castas||[]);
      RC['regiao_'+c]={lista,rows:rr,titulo:nome+' por região',rot:'Top Região '+nome};
      RC['casta_'+c]={lista,rows:cr,titulo:nome+' por casta',rot:'Top Casta '+nome,casta:true};
    });
    ['regiao_tinto','regiao_branco','casta_tinto','casta_branco'].forEach(q=>{
      const r=RC[q], top=r.rows.find(x=>x.nome!=='Sem região');
      if(top)favHtml+=scCardFav(r.rot,top.nome,`${top.n} vinho${top.n===1?'':'s'}`,q);
    });
  }
  if(topRegiao&&!cat)favHtml+=scCardFav('Região preferida',topRegiao.nome,
    `${topRegiao.n} vinho${topRegiao.n===1?'':'s'}`,'regiao');
  if(topCasta&&!cat)favHtml+=scCardFav('Casta preferida',topCasta.nome,
    `${topCasta.n} vinho${topCasta.n===1?'':'s'}${topCastaMono?`, ${topCastaMono} monocasta`:''}`,'casta');

  const onde=cat?'no catálogo':'na garrafeira';
  let html=
    scCard('','Vinhos',totalVinhos,(totalVinhos===1?'vinho ':'vinhos ')+onde,null)+
    (cat?scCard('cv','Tintos',tintos.length,totalVinhos?`de ${totalVinhos} vinhos`:'','cor')+
         scCard('cb','Brancos',brancos.length,totalVinhos?`de ${totalVinhos} vinhos`:'','cor'):'')+
    scCard('co','Monocasta',monoWines.length,totalVinhos?`de ${totalVinhos} vinhos`:'','mono')+
    scCard('cv','Regiões',nRegioes,'diferentes','regiao')+
    scCard('cb','Castas',casRows.length,'diferentes','casta')+
    favHtml+
    (cat?'':scCard('co','Valor estimado',`<span class="sc-eur">${esc(eur0(valorTotal))}</span>`,
      comPreco.length===ativas.length?`${ativas.length} garrafa${ativas.length===1?'':'s'}`
        :`${comPreco.length} de ${ativas.length} garrafas com preço`,'valor'))+
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
  if(RESUMO_ABERTO==='cor'){
    const corRows=contarPor(comStock,v=>[v.tipo||'Sem cor']);
    html+=resumoPainel('cor','Vinhos por cor',corRows,v=>(v.tipo||'Sem cor')===RESUMO_DRILL,comStock);
  }
  if(RC[RESUMO_ABERTO]){
    const r=RC[RESUMO_ABERTO];
    html+=resumoPainel(RESUMO_ABERTO,r.titulo,r.rows,
      r.casta?v=>(v.castas||[]).includes(RESUMO_DRILL):v=>(v.regiao||'Sem região')===RESUMO_DRILL,r.lista);
  }
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
    info.classList.remove('on');fl.style.display='none';fc.textContent='';
  }else{
    info.classList.add('on');fl.style.display='';
    const res=vinhosFiltrados();
    const nGar=res.reduce((s,v)=>s+stockDe(v.id),0);
    fc.textContent=`${res.length} vinho${res.length===1?'':'s'}`+(modoCat()?'':` · ${nGar} garrafa${nGar===1?'':'s'}`);
  }
  renderDetalhe();
  // No catálogo não há Locais à vista: o mapa volta a desenhar-se ao
  // regressar à garrafeira (o `modoAlternar` chama isto outra vez).
  if(!modoCat())renderMapa();
}

/* ── FILTROS ───────────────────────────────────────────────────────
   Os valores possíveis de cada filtro saem SEMPRE dos dados que lá estão
   (não de listas fixas): assim uma região nova aparece no filtro sozinha,
   e nunca fica um filtro a apontar para coisa nenhuma. */
/* TRÊS deles são LISTAS — cor, região e castas — e os outros nove um valor
   só. Não é capricho nem simetria por simetria: são as três perguntas que
   se fazem sempre ("um tinto do Douro de Touriga?") e são as únicas onde
   escolher DUAS opções quer dizer alguma coisa. "Tinto ou Branco" e "Douro
   ou Alentejo" são perguntas legítimas; "2019 ou 2021" já se responde
   melhor pela organização por ano, e "Reserva ou Grande Reserva" quase
   nunca se pergunta. Quem sabe a diferença é o próprio `F`: `ehLista(k)`
   pergunta se o valor guardado é um array, e o `campoToggle` acrescenta ou
   tira num caso e troca no outro — tocar no valor já escolhido limpa-o, que
   é como se desmarca um campo de valor único sem um "qualquer" postiço na
   lista. Os doze passam pelo MESMO desenho (a fita e os cartões com
   contagem); os `<select>` nativos que os oito costumavam usar saíram com
   os andares, porque um seletor nativo não mostra contagens e a contagem é
   o que faz este painel valer a pena.
   As CASTAS ainda têm uma coisa a mais: só nelas a mesma escolha tem duas
   leituras legítimas — qualquer uma delas (o costume) ou os lotes que levam
   TODAS (`CASTAS_TODAS`). Um vinho tem UMA cor e UMA região; "tinto E
   branco" não existe, e por isso o visto não aparece nos outros campos.
   É a mesma decisão, o mesmo desenho e o mesmo vocabulário do Catálogo da
   WineCatalog: quem anda nas duas apps não aprende dois nomes para a mesma
   coisa. */
let F={local:'',tipo:[],regiao:[],casta:[],produtor:'',ano:'',mencao:'',preco:'',teor:'',estagio:'',janela:'',vivino:''};
let CASTAS_TODAS=false;
try{CASTAS_TODAS=localStorage.getItem('gf_castas_todas')==='1';}catch(e){}
/* "Só monocasta" foi um VALOR do campo "Nº de castas" e agora é um estado
   seu — o campo saiu da fita, porque das três respostas que dava
   (monocasta · várias castas · sem castas registadas) só a primeira se
   perguntava, e essa pergunta faz-se onde se escolhe a casta.
   NÃO se grava, ao contrário do `CASTAS_TODAS`, e a diferença não é
   descuido: o "todas em simultâneo" só morde quando há castas escolhidas,
   e essas não sobrevivem ao recarregar — já este morde SOZINHO. Gravado,
   era abrir a app noutro dia com metade da garrafeira escondida e nada no
   ecrã a dizer porquê. */
let CASTAS_MONO=false;
// Um filtro "ligado" é um valor escolhido — mas uma lista VAZIA é um objeto
// e portanto truthy. Sem isto, `haFiltros()` dava sempre verdadeiro a partir
// do dia em que estes três passaram a listas, e a app abria sempre em modo
// "a filtrar" com a lista toda lá dentro.
function filtroLigado(k){const v=F[k];return Array.isArray(v)?v.length>0:!!v;}

/* ── O PAINEL: a procura SEMPRE, os filtros um campo de cada vez ─────
   Doze filtros abertos de uma vez são doze decisões à frente de quem só
   queria escrever "crasto". Já se tentou escondê-los todos atrás de um
   botão (tudo ou nada) e já se tentou abri-los por andares — e o andar que
   mostrava cor + região + castas ao mesmo tempo dava meio ecrã de cartões
   antes de se chegar à lista.
   Agora são dois passos e mais nenhum:
     · a PROCURA LIVRE está sempre à vista — é o que se usa em nove de cada
       dez vezes, e um pedaço do nome chega;
     · o botão "Filtros" abre uma FITA horizontal com os doze campos
       (`.fcampos`). Escolhe-se UM, e só os valores DESSE campo abrem por
       baixo (`FILTRO_CAMPO`).
   O que isto ganha é altura: a fita é uma linha, e o painel de valores é o
   de um campo só em vez dos doze. O que custa é um toque a mais para trocar
   de campo — e é um toque que se dá poucas vezes, porque quem filtra por
   região raramente filtra por teor a seguir. */
let FILTROS_ABERTO=false;
let FILTRO_CAMPO=null;   // que campo tem os valores abertos, ou nenhum
try{FILTROS_ABERTO=localStorage.getItem('gf_filtros_aberto')==='1';}catch(e){}
function filtrosToggle(){
  FILTROS_ABERTO=!FILTROS_ABERTO;
  if(!FILTROS_ABERTO)FILTRO_CAMPO=null;
  try{localStorage.setItem('gf_filtros_aberto',FILTROS_ABERTO?'1':'0');}catch(e){}
  renderFiltros();
}
// Tocar no campo que já está aberto fecha-o: a fita volta a ser uma linha
// só, que é o estado em que se anda quando não se está a escolher nada.
function abrirCampo(k){
  FILTRO_CAMPO=(FILTRO_CAMPO===k)?null:k;
  renderFiltros();
}

/* OS DOZE CAMPOS, num sítio só: chave, ícone, nome e se aceita MAIS DO QUE
   UM valor. Cor, região e castas aceitam; os outros nove não — são as três
   perguntas que se fazem sempre ("um tinto do Douro de Touriga?") e as
   únicas onde escolher duas opções quer dizer alguma coisa. "Tinto ou
   Branco" e "Douro ou Alentejo" são perguntas legítimas; "2019 ou 2021"
   responde-se melhor pela organização por ano, e "Reserva ou Grande
   Reserva" quase nunca se pergunta.
   A ORDEM é a da fita, e não é alfabética: as três de sempre primeiro,
   porque são as que se abrem. */
const F_CAMPOS=[
  ['tipo','🍷','Cor',1],['regiao','🗺️','Região',1],['casta','🍇','Castas',1],
  ['local','📍','Local',0],['produtor','🏭','Produtor',0],['ano','📅','Ano',0],
  ['mencao','🏅','Menção',0],['preco','💶','Preço',0],['teor','🌡️','Grau',0],
  ['estagio','🪵','Estágio',0],['janela','⏱️','Maturação',0],['vivino','★','Vivino',0]
];
const F_META={};
F_CAMPOS.forEach(([k,ico,nome])=>{F_META[k]=[ico,nome];});
function ehLista(k){return Array.isArray(F[k]);}
// O que está escolhido num campo, sempre como lista — poupa o `if` entre
// os que são lista e os que não são em cada sítio que lhes toca.
function ligados(k){const v=F[k];return Array.isArray(v)?v:(v?[v]:[]);}

/* QUE VALOR(ES) ESTE VINHO TEM NESTE CAMPO — e é a ÚNICA definição disto
   na app. Filtrar e contar são a mesma pergunta feita duas vezes ("este
   vinho é Tinto?"), e enquanto foram dois blocos de código a resposta podia
   divergir: bastava alguém corrigir o filtro e esquecer a contagem para o
   cartão dizer "Tinto 8" com sete vinhos na lista.
   Um vinho sem valor devolve lista VAZIA, e isso é o que o exclui de
   qualquer filtro nesse campo — um vinho sem preço médio não está em faixa
   de preço nenhuma, não está na primeira. */
function valorDe(v,k){
  switch(k){
    case 'tipo':    return v.tipo?[v.tipo]:[];
    case 'regiao':  return v.regiao?[v.regiao]:[];
    case 'casta':   return v.castas||[];
    case 'produtor':return v.produtor?[v.produtor]:[];
    case 'mencao':  return v.mencao?[v.mencao]:[];
    case 'ano':     return v.ano?[String(v.ano)]:[];
    case 'local':   return [...new Set(garrafasDe(v.id,true).map(g=>String(g.local_id)))];
    case 'preco':   {const x=precoVinho(v);return x==null?[]:[String(faixaIndice(x))];}
    case 'teor':    return v.teor==null?[]:[String(faixaTeorIndice(v.teor))];
    case 'estagio': return estagioDe(v);
    case 'vivino':  {const x=notaVivinoNum(v);return x==null?[]:[String(faixaVivinoIndice(x))];}
    /* A maturação não filtra por "No ponto" — filtra pelo TERÇO da janela.
       "No ponto" sozinho está em quase todos os vinhos e devolvia a lista
       quase inteira; a pergunta que sobra é em que parte da janela se está.
       Um vinho no ponto mas sem as duas pontas não tem terço, e por isso
       não entra em nenhum. */
    case 'janela':  {
      const e=janelaBeber(v);
      if(e!=='ponto')return e?[e]:[];
      const f=(janelaFase(v)||[])[1];
      return f?['ponto:'+f]:[];
    }
  }
  return [];
}

/* OS VALORES POSSÍVEIS DE UM CAMPO, por ordem e com o rótulo que se lê.
   Os que saem dos DADOS (cor, região, casta, produtor, ano, local, menção)
   saem sempre do que lá está — assim uma região nova aparece sozinha e
   nunca fica um filtro a apontar para coisa nenhuma. Os que são FAIXAS
   (preço, grau, Vivino) e os fechados (maturação, nº de castas) têm lista
   própria, que é o que os torna perguntas em vez de valores. */
function valoresDe(k){
  const comStock=vinhosBase();
  const dados=()=>[...new Set([].concat(...comStock.map(v=>valorDe(v,k))))];
  const pt=(a,b)=>String(a).localeCompare(String(b),'pt');
  switch(k){
    // As cores pela ordem do vocabulário (`TIPOS`), não alfabética: Tinto
    // antes de Branco é como se fala de vinho; "Branco · Espumante ·
    // Frisante · Licoroso · Rosé · Tinto" não é.
    case 'tipo':{const t=dados();
      return TIPOS.filter(x=>t.includes(x)).concat(t.filter(x=>!TIPOS.includes(x)).sort(pt))
        .map(x=>[x,x]);}
    case 'local':return db.locais
      .filter(l=>db.garrafas.some(g=>g.local_id===l.id&&naGarrafeira(g)))
      .map(l=>[String(l.id),l.nome]);
    case 'ano':return dados().sort((a,b)=>b-a).map(x=>[x,x]);
    // As palavras são as mesmas que a ficha do vinho escreve (`FASES`) —
    // quem filtra por uma tem de a reconhecer quando abre o vinho.
    case 'janela':return [...FASES.map(f=>['ponto:'+f[1],'No ponto · '+f[2]]),
      ['cedo','Ainda cedo'],['passou','Já passou']];
    case 'vivino':return FAIXAS_VIVINO.map((f,i)=>[String(i),f.nome]);
    case 'preco':return FAIXAS_PRECO.map((f,i)=>[String(i),f.nome]);
    case 'teor':return FAIXAS_TEOR.map((f,i)=>[String(i),f.nome]);
    case 'estagio':return ESTAGIO_OPCOES;
    default:return dados().sort(pt).map(x=>[x,x]);
  }
}
function rotuloFiltro(k,val){
  const p=valoresDe(k).find(x=>x[0]===val);
  return p?p[1]:val;
}

/* AS CONTAGENS DO CAMPO ABERTO. Cada valor diz quantos vinhos dá, e é isso
   que separa este painel de uma lista de caixas: escolher deixa de ser
   adivinhar. Sem os números, qualquer escolha podia dar "Nada encontrado" a
   quem tinha acabado de tocar numa opção que a app lhe ofereceu; com eles,
   um caminho sem saída nem chega a aparecer.
   A regra é a da `facetas` da WineCatalog: conta-se com os OUTROS campos
   aplicados mas NÃO com o próprio. É isso que faz "Branco 7" continuar
   visível depois de se escolher Tinto — senão, escolher uma cor apagava
   todas as outras e não havia como acrescentar uma segunda.
   Um valor que dê zero não aparece; um ESCOLHIDO aparece sempre, mesmo a
   zero, senão não havia como o desmarcar.
   As castas em "todas em simultâneo" são a exceção dentro da exceção:
   cada casta candidata só conta nos vinhos que TAMBÉM levam as outras já
   escolhidas — é a pergunta a que o cartão tem de responder ("se eu juntar
   esta, com quantos fico?"). De outro modo dizia "Syrah 28" com a lista a
   mostrar três vinhos.
   Só corre para o campo ABERTO: varrer a garrafeira doze vezes para
   desenhar uma fita de doze nomes era trabalho que ninguém ia ler. */
function opcoesCampo(k){
  const termos=termosProcura();
  const base=vinhosUniverso().filter(v=>passaFiltros(v,termos,k));
  const m=new Map();
  base.forEach(v=>{
    const cs=v.castas||[];
    valorDe(v,k).forEach(x=>{
      if(k==='casta'&&CASTAS_TODAS&&!F.casta.every(c=>c===x||cs.includes(c)))return;
      m.set(x,(m.get(x)||0)+1);
    });
  });
  const on=ligados(k);
  return valoresDe(k).map(([v,r])=>[v,r,m.get(v)||0])
    .filter(o=>o[2]>0||on.includes(o[0]));
}

function campoToggle(k,v){
  if(ehLista(k)){
    const i=F[k].indexOf(v);
    if(i<0)F[k].push(v);else F[k].splice(i,1);
  }else{
    // Num campo de um valor só, tocar no que já está escolhido LIMPA-O —
    // é a única saída que ele tem sem se ir às pastilhas.
    F[k]=(F[k]===v)?'':v;
  }
  renderFiltrados();
}

/* As duas regras das castas, por cima dos valores, e são MUTUAMENTE
   EXCLUSIVAS — não por arrumação, por aritmética: um vinho monocasta tem
   UMA casta, por isso nunca leva "todas" as duas escolhidas. Ter as duas
   ligadas era pedir uma lista que não pode existir, e a app respondia
   "Nada encontrado" sem dizer porquê. Ligar uma desliga a outra.
   O "só monocasta" já foi um valor do campo "Nº de castas" e passou a
   viver só aqui: é aqui que faz falta, porque é aqui que se escolhe a
   casta — "Syrah" e "só monocasta" juntos são "os meus 100% Syrah", que é
   a pergunta a seguir à casta e não uma sobre números. */
function castasRegrasHTML(){
  const mono=CASTAS_MONO;
  const b=(on,fn,txt,tit)=>`<button class="fmodo${on?' on':''}" onclick="${fn}()" title="${esc(tit)}">
    <i class="fvisto">✓</i> ${esc(txt)}</button>`;
  return `<div class="fregras">
    ${b(mono,'castasMono','só monocasta',
       mono?'A mostrar só os vinhos feitos de uma casta única'
           :'A mostrar também os lotes que levam esta casta com outras')}
    ${(!mono&&F.casta.length>1)
      ? b(CASTAS_TODAS,'castasModo','todas em simultâneo',
          CASTAS_TODAS?'A mostrar só os vinhos que levam TODAS as castas escolhidas'
                      :'A mostrar os vinhos que levam QUALQUER UMA das castas escolhidas')
      : ''}
  </div>`;
}

function renderFiltros(){
  document.getElementById('filtros').classList.toggle('aberto',FILTROS_ABERTO);

  /* A FITA. Cada campo diz-se pelo nome, e leva o número dos valores que
     tem ligados — é o que permite ver, sem abrir nenhum, onde é que está o
     filtro que está a cortar a lista. */
  document.getElementById('f-campos').innerHTML=camposVisiveis().map(([k,ico,nome])=>{
    const n=ligados(k).length;
    return `<button class="fcampo${n?' ativo':''}${FILTRO_CAMPO===k?' aberto':''}"
      onclick="abrirCampo('${escJs(k)}')">${ico} ${esc(nome)}${
      n?`<i class="fcn">${n}</i>`:''}</button>`;
  }).join('');

  /* OS VALORES do campo aberto. Grelha de duas colunas e não um
     `flex-wrap`, pela mesma pedra da WineCatalog: com três por linha
     "Península de Setúbal" e "Cabernet Sauvignon" chegam ao ecrã cortadas
     a meio, e um filtro que não se lê não se escolhe; com `flex-grow`, o
     último cartão de uma linha ímpar estica-se sozinho de ponta a ponta. */
  const dom=document.getElementById('f-dominio');
  if(FILTROS_ABERTO&&FILTRO_CAMPO){
    const k=FILTRO_CAMPO,ops=opcoesCampo(k);
    dom.innerHTML=(k==='casta'?castasRegrasHTML():'')+(ops.length
      ? `<div class="fops">${ops.map(([v,r,n])=>{
          const on=ligados(k).includes(v);
          const cor=k==='tipo'?(VIDRO[v]||null):null;
          return `<button class="fop${on?' on':''}" onclick="campoToggle('${escJs(k)}','${escJs(v)}')">
            <span class="fop-tx">${cor?`<i class="fponto" style="background:${esc(cor)}"></i>`:''}${esc(r)}</span>
            <span class="fconta">${n}</span>
          </button>`;
        }).join('')}</div>`
      : `<p class="fvazio">Nada a escolher aqui com os filtros que estão ligados.</p>`);
  }else dom.innerHTML='';

  /* AS PASTILHAS DIZEM O QUE NÃO SE VÊ DAQUI. É a regra toda: o campo que
     está aberto já se lê nos cartões acesos, e repeti-lo por baixo era
     dizer a mesma coisa duas vezes. Todos os outros aparecem, com o ✕ de
     cada um — desfazer uma escolha de cada vez, não tudo ou nada.
     O "+" entre duas castas só existe em "todas em simultâneo": sem ele,
     "Touriga Nacional · Syrah" mente sobre metade dos resultados. */
  const pastilhas=[];
  // O monocasta não é valor de campo nenhum, mas corta a lista como um: com
  // as castas fechadas, esta pastilha é a única coisa a dizê-lo.
  if(CASTAS_MONO&&!(FILTROS_ABERTO&&FILTRO_CAMPO==='casta'))
    pastilhas.push(`<span class="fpill">🍇 Só monocasta
      <button onclick="castasMono()" title="Tirar este filtro">✕</button></span>`);
  F_CAMPOS.forEach(([k,ico])=>{
    if(FILTROS_ABERTO&&FILTRO_CAMPO===k)return;
    ligados(k).forEach((v,i)=>{
      if(i&&k==='casta'&&CASTAS_TODAS)pastilhas.push('<span class="fjunta">+</span>');
      pastilhas.push(`<span class="fpill">${ico} ${esc(rotuloFiltro(k,v))}
        <button onclick="campoToggle('${escJs(k)}','${escJs(v)}')" title="Tirar este filtro">✕</button></span>`);
    });
  });
  document.getElementById('f-activos').innerHTML=pastilhas.join('');

  // O número no botão é o de VALORES escolhidos e não o de campos: três
  // castas não são "1 filtro", e com o painel fechado é a única medida do
  // que está a cortar a lista por baixo.
  const nAtivos=F_CAMPOS.reduce((s,[k])=>s+ligados(k).length,0)+(CASTAS_MONO?1:0);
  const n=document.getElementById('f-n');
  n.textContent=nAtivos;n.classList.toggle('on',!!nAtivos);
}
// Aceita um valor solto em qualquer campo, seja lista ou não — é o que
// mantém de pé quem lhe chame sem saber de qual é qual.
function setFiltro(k,v){
  if(ehLista(k))F[k]=v?[v]:[];
  else F[k]=v;
  renderFiltrados();
}

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

/* O ESTÁGIO é texto livre ("18 meses em barricas novas de carvalho francês,
   seguidos de 12 meses em garrafa") e um número (`estagio_meses`) que nem
   sempre concorda com ele. Nos dados, quase tudo é barrica de carvalho
   francês — filtrar pela madeira ou pela origem do carvalho devolvia a
   lista quase inteira. O que VARIA é quanto tempo passou em madeira e,
   nalguns, onde estagiou em vez dela. Daí três perguntas num campo só:
     · sem madeira — inox, cimento, ânfora, ou "sem estágio em madeira";
     · QUANTO TEMPO em madeira, em quatro faixas (a de 12 meses é a mais
       comum; 13 a 18 é o "Reserva" típico; mais de 18 é madeira longa);
     · as duas formas que se reconhecem pelo nome: tonel/balseiro (madeira
       GRANDE e velha, a do Douro e do Alentejo antigos) e ânfora/talha.
   Um vinho pode estar em duas ("18 meses em tonéis" é 13–18 E tonel; uma
   talha é também sem madeira) — o `valorDe` devolve lista, como nas castas.
   Os meses saem do TEXTO primeiro, porque é o texto que a ficha do vinho
   mostra e o número às vezes está errado (há "12 meses em madeira e 24 em
   garrafa" com 36 no número); o número só vale quando o texto não diz.
   TODOS os vinhos caem em pelo menos uma opção, e é o que as duas últimas
   garantem: sem texto e com 0 meses é "Sem informação" (é o valor por
   defeito da importação, não "sem madeira" — seria dizer que 30 vinhos não
   passaram por madeira sem ninguém o ter escrito); um estágio escrito que
   não encaixa em nenhuma das outras ("Estágio em barricas de carvalho",
   sem os meses) é "Outras opções de estágio". */
const ESTAGIO_OPCOES=[
  ['sem','Sem madeira'],
  ['m6','Madeira · até 6 meses'],
  ['m12','Madeira · 7 a 12 meses'],
  ['m18','Madeira · 13 a 18 meses'],
  ['m99','Madeira · + 18 meses'],
  ['tonel','Tonel / balseiro'],
  ['anfora','Ânfora / talha'],
  ['outro','Outras opções de estágio'],
  ['nd','Sem informação']
];
const RE_MADEIRA=/barric|madeira|carvalho|\btone(l|is)\b|balseir|\bpip[ao]s?\b|\bcasco|\bbarril/;
// O que NÃO é madeira: onde estagiou em vez dela, ou a garrafa depois dela.
const RE_NAO_MADEIRA=/garrafa|inox|\baco\b|\bcubas?\b|cimento|\bbetao|\banforas?\b|\btalhas?\b|\bbarro\b|borras/;
const RE_SEM_MADEIRA=/\bsem (?:estagio (?:em|de) |passagem (?:em|por) |passar por )?(?:madeira|barricas?|carvalho)|unoaked/g;
const NUM_PT={um:1,uma:1,dois:2,duas:2,tres:3};
/* Os meses em madeira ditos no texto: o PRIMEIRO "N meses" que fala de
   madeira — ou de nada ("12 meses, 50% em carvalho e 50% em cuba"). Salta
   os que falam de outra coisa ANTES de falar de madeira ("24 meses em
   garrafa", "3 meses sobre borras"). Anos só contam com madeira à frente:
   "vinhas com mais de 60 anos" não é estágio nenhum. Num intervalo ("12 a
   18 meses") vale o maior. */
function estagioMesesTexto(t){
  const re=/\b(\d+|um|uma|dois|duas|tres)(?:\s*(?:a|-)\s*(\d+))?\s*(mes(?:es)?|anos?)\b([^.;,]{0,60})/g;
  let m;
  while((m=re.exec(t))){
    const n=Number(m[2]||(NUM_PT[m[1]]??m[1]));
    const ano=m[3].startsWith('ano');
    const iw=m[4].search(RE_MADEIRA),io=m[4].search(RE_NAO_MADEIRA);
    const madeira=iw>=0&&(io<0||iw<io);
    if(madeira||(!ano&&iw<0&&io<0))return ano?n*12:n;
  }
  return null;
}
// Por conteúdo e não por vinho: a mesma ficha dá sempre a mesma resposta,
// e editar o estágio muda a chave — não há cache a invalidar.
const _ESTAGIO=new Map();
function estagioDe(v){
  const txt=v.estagio_texto||'',col=Number(v.estagio_meses)||0;
  const k=txt+'\u0001'+col;
  if(_ESTAGIO.has(k))return _ESTAGIO.get(k);
  const bruto=chave(txt);
  const negou=RE_SEM_MADEIRA.test(bruto);
  RE_SEM_MADEIRA.lastIndex=0;
  const t=bruto.replace(RE_SEM_MADEIRA,' ');
  const out=[];
  let madeira=false,meses=null;
  if(t.trim()){
    madeira=RE_MADEIRA.test(t);
    if(madeira)meses=estagioMesesTexto(t)??(col||null);
    else if(negou||RE_NAO_MADEIRA.test(t))out.push('sem');
  }else if(negou)out.push('sem');
  else if(col>0){madeira=true;meses=col;}   // o número é "meses em barrica/madeira"
  if(madeira&&meses)out.push(meses<=6?'m6':meses<=12?'m12':meses<=18?'m18':'m99');
  if(/\btone(l|is)\b|balseir/.test(t))out.push('tonel');
  if(/\b(anforas?|talhas?)\b/.test(t))out.push('anfora');
  if(!out.length)out.push((txt.trim()||col)?'outro':'nd');
  _ESTAGIO.set(k,out);
  return out;
}
function limparTexto(){
  const c=document.getElementById('f-texto');
  c.value='';renderFiltrados();c.focus();
}
/* Trocar de regra com menos de duas castas não muda lista nenhuma, mas o
   estado grava-se à mesma: quem liga o visto espera que ele lá esteja da
   próxima vez. */
function castasModo(){
  CASTAS_TODAS=!CASTAS_TODAS;
  try{localStorage.setItem('gf_castas_todas',CASTAS_TODAS?'1':'0');}catch(e){}
  renderFiltrados();
}
/* Ligar o "só monocasta" desliga o "todas em simultâneo", que com monocasta
   pede uma lista impossível — um vinho de uma casta só nunca leva duas. */
function castasMono(){
  CASTAS_MONO=!CASTAS_MONO;
  if(CASTAS_MONO&&CASTAS_TODAS){
    CASTAS_TODAS=false;
    try{localStorage.setItem('gf_castas_todas','0');}catch(e){}
  }
  renderFiltrados();
}
// Só o ESTADO, sem desenhar. Quem troca de garrafeira precisa de esquecer
// os filtros ANTES de os dados novos chegarem, e um `renderFiltrados()` aqui
// desenhava a garrafeira anterior mais uma vez, já sem filtros — um piscar
// de olhos com a lista de outra pessoa.
function esquecerFiltros(){
  Object.keys(F).forEach(k=>{F[k]=Array.isArray(F[k])?[]:'';});
  /* Limpar tem de devolver o painel ao estado de partida: um visto que
     sobrevivesse à limpeza era uma regra escondida a filtrar por baixo na
     escolha seguinte. */
  CASTAS_TODAS=false;CASTAS_MONO=false;
  try{localStorage.setItem('gf_castas_todas','0');}catch(e){}
  const t=document.getElementById('f-texto');
  if(t)t.value='';
}
function limparFiltros(){
  esquecerFiltros();
  renderFiltrados();
}
function haFiltros(){
  // O `CASTAS_MONO` é a única coisa que filtra e não vive no `F` — sem ele
  // aqui, "só monocasta" sozinho cortava a lista com a app a dizer que não
  // estava a filtrar nada.
  return CASTAS_MONO||Object.keys(F).some(filtroLigado)
    ||!!document.getElementById('f-texto').value.trim();
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
/* `ignorar` é o nome de um filtro a saltar — serve às contagens do próprio
   grupo (ver `facetas`), que têm de ser feitas com os OUTROS filtros
   aplicados mas não com o seu. */
function vinhosFiltrados(ignorar){
  const termos=termosProcura();
  return vinhosUniverso().filter(v=>passaFiltros(v,termos,ignorar));
}
function passaFiltros(v,termos,ignorar){
  if(v.id>0&&!garrafasDe(v.id,true).length)return false;   // só o que está lá (o catálogo é todo)
  for(const [k] of F_CAMPOS){
    if(k===ignorar)continue;
    const sel=ligados(k);
    if(!sel.length)continue;
    const tem=valorDe(v,k);
    /* As castas em "todas em simultâneo" são a única leitura em E; todos os
       outros campos são em OU. Um vinho tem UMA cor e UMA região, e "tinto
       E branco" não existe — por isso o visto só aparece nas castas.
       "Levar todas" e não "ser exatamente estas": um lote com uma terceira
       casta conta. */
    if(k==='casta'&&CASTAS_TODAS){
      if(!sel.every(x=>tem.includes(x)))return false;
    }else if(!sel.some(x=>tem.includes(x)))return false;
  }
  /* O "só monocasta" fica FORA do ciclo, e por duas razões. Morde sozinho,
     sem casta nenhuma escolhida ("mostra-me os meus monovarietais"), e o
     ciclo salta os campos vazios. E não obedece ao `ignorar`: quando se
     contam as opções do campo das castas, o que o cartão tem de responder
     é "quantos MONOVARIETAIS de cada casta" — a restrição fica na base,
     que é o que a mantinha certa quando isto era o campo "Nº de castas". */
  if(CASTAS_MONO&&(v.castas||[]).length!==1)return false;
  return passaTexto(v,termos);
}
// Dentro de cada grupo (região, ano ou casta), do melhor Vivino para o
// pior — é a pergunta natural depois de já se ter escolhido o grupo: "qual
// destes bebo primeiro?". Sem nota fica no fim, por nome.
function ordenarPorVivino(lista){
  return lista.slice().sort((a,b)=>
    (notaVivinoNum(b)??-1)-(notaVivinoNum(a)??-1)||a.nome.localeCompare(b.nome,'pt'));
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
// Duas garrafas do mesmo vinho no MESMO sítio não valem duas linhas. Cada
// sítio leva o pip com a cor do local — é o que restou da barra de cor.
// Sai daqui para fora do cartão porque a grelha (`vinhoGrelhaHTML`) mostra
// os mesmos sítios noutro formato, e duas cópias desta conta divergiam no
// dia em que alguém mexesse numa.
function sitiosDe(gs){
  const sitios=[];
  gs.forEach(g=>{
    const txt=nomeLocal(g.local_id)+(g.prateleira?' · '+g.prateleira:'');
    if(!sitios.some(x=>x.txt===txt))sitios.push({txt,cor:(IDXL[g.local_id]||{}).cor||'#7b1f3d'});
  });
  return sitios;
}
/* A linha de quem é o vinho, nos dois cartões: [cor] [região] [ano], por
   esta ordem (pedido do dono das apps, 27/09/2026; igual no Catálogo da
   WineCatalog). Na LISTA vai colada ao nome, na mesma linha, e quebra com
   ele quando o nome é comprido — cada pedaço em `nowrap`, para a quebra
   cair ENTRE eles e nunca a meio de "Península de Setúbal". Na GRELHA é a
   linha de baixo do nome. O produtor fica sempre numa linha só dele.
   `ano` vem de fora porque cada cartão decide o que diz sem ele ('s/a' ou
   nada, na wishlist). */
function vinhoMetaHTML(v,ano){
  const p=[];
  if(v.tipo)p.push(`<span class="vc-cor">${esc(v.tipo)}</span>`);
  if(v.regiao)p.push(`<span class="vm-reg">${esc(v.regiao)}</span>`);
  if(ano)p.push(`<span class="vm-ano">${esc(String(ano))}</span>`);
  return p.length?`<span class="vc-meta">${p.join('<span class="vm-sep"> · </span>')}</span>`:'';
}
function vinhoCardHTML(v,termos,loteSel){
  const gs=garrafasDe(v.id,true);
  const cl=castaLabel(v);
  const jan=janelaBeber(v);
  const castas=v.castas||[];
  const castasTxt=castas.length
    ? castas.slice(0,2).join(' · ')+(castas.length>2?' +'+(castas.length-2):'')
    : '';
  const sitios=sitiosDe(gs);
  const on=loteSel&&loteSelTem(v.id);
  const cheio=loteSel&&!on&&loteSelCheio();
  const clique=loteSel?`loteSelToggle(${v.id})`:`verVinho(${v.id})`;
  // Na wishlist, sem ano quer dizer "qualquer colheita" e não uma falta: o
  // "s/a" lia-se como um dado em branco. Cala-se, e a nota do Vivino sobe
  // para o lugar dele. Um desejo COM ano (uma colheita em concreto) mostra-o.
  const semAno=!v.ano&&desejado(v);
  return `<article class="vcard${loteSel?' lote-modo':''}${on?' lote-on':''}${cheio?' lote-cheio':''}${catFundoCls(v)}" onclick="${clique}">
    <div class="vc-top">
      ${vinhoThumb(v,gs.length)}${loteSel?`<span class="lote-chk">✓</span>`:''}
      <div class="vc-main">
        ${notaVivino(v)?`<div class="vc-anofloat">${notaVivinoBadge(v)}</div>`:''}
        <div class="vc-nome">${esc(v.nome)} ${vinhoMetaHTML(v,semAno?'':(v.ano||'s/a'))}</div>
        ${v.produtor?`<div class="vc-prod">${esc(v.produtor)}</div>`:''}
        <div class="vc-badges">
          ${castasTxt?`<span class="bdg cas">🍇 ${esc(castasTxt)}</span>`:''}
          ${cl?`<span class="bdg mono">${esc(cl)}</span>`:''}
          ${v.mencao?`<span class="bdg men">${esc(v.mencao)}</span>`:''}
          ${precoBadge(v)}
        </div>
        ${(()=>{
          // No catálogo o rodapé pode não ter nada (nem garrafas, nem janela):
          // sem isto ficava o filete sozinho a separar coisa nenhuma.
          const pe=sitios.map(x=>`<span class="vc-l"><span class="vc-pip" style="background:${esc(x.cor)}"></span><b>${esc(x.txt)}</b></span>`).join('')
            +(v.id<0?catTensHTML(v):'')+janelaBadge(v,jan);
          return pe.trim()||v.id>0?`<div class="vc-foot">${pe}</div>`:'';
        })()}
      </div>
    </div>
    ${trechosMatch(v,termos)}
  </article>`;
}
/* A GRELHA: o mesmo vinho, dito pela GARRAFA em vez de pela ficha.
   Não é o cartão da lista encolhido — é outra pergunta. Na lista lê-se o
   que um vinho É (castas, menção, preço, maturação); na grelha procura-se
   um RÓTULO que já se viu, e por isso a garrafa cresce e o resto encolhe
   até ao que identifica: nome, ano, produtor/região e a NOTA.
   O que NÃO entra na grelha é o rodapé do que é físico por inteiro — onde
   está, a maturação, o preço, os crachás das castas: numa coluna de 150px
   cada um deles é uma linha a mais e o que se perde é a fotografia, que é
   a razão de estar aqui. Quem quer isso tem a lista a um toque, e a ficha
   do vinho a dois.
   O SÍTIO saiu já depois de entrar, e por medida: partilhava a linha com a
   nota, e "Cave · Nível 7 · lugar 12" num cartão de 150px comia-a toda. A
   nota ficou sozinha na linha dela — é o número por que se escolhe um
   vinho de relance, e é o único que ali cabe inteiro.
   A faixa da procura (`trechosMatch`) entra nos DOIS — e na grelha ainda
   com mais razão: o cartão mostra menos, logo há mais palavra encontrada
   fora da vista. É a mesma função e o mesmo texto, nunca uma segunda
   versão mais curta. */
/* O cartão da grelha NÃO é o da lista encolhido — é outra pergunta: na
   lista lê-se o que um vinho É, na grelha procura-se um RÓTULO que já se
   viu. Por isso a garrafa cresce e o resto encolhe até ao que identifica.
   O rodapé ficou só com a NOTA, numa linha só dela: o "onde está" saiu
   daqui porque numa coluna de 150px ele e a nota disputavam a mesma linha
   e a nota — que é o que faz escolher entre dois rótulos — ficava a
   competir com um "Sala +1" que se lê na lista e na ficha do vinho. */
function vinhoGrelhaHTML(v,termos,loteSel){
  const gs=garrafasDe(v.id,true);
  const on=loteSel&&loteSelTem(v.id);
  const cheio=loteSel&&!on&&loteSelCheio();
  const clique=loteSel?`loteSelToggle(${v.id})`:`verVinho(${v.id})`;
  return `<article class="vgcard${loteSel?' lote-modo':''}${on?' lote-on':''}${cheio?' lote-cheio':''}${catFundoCls(v)}" onclick="${clique}">
    ${vinhoThumb(v,gs.length)}${loteSel?`<span class="lote-chk">✓</span>`:''}
    <div class="vg-nome">${esc(v.nome)}</div>
    <div class="vg-sub">${vinhoMetaHTML(v,desejado(v)&&!v.ano?'':(v.ano||'s/a'))}</div>
    ${v.produtor?`<div class="vg-prod">${esc(v.produtor)}</div>`:''}
    <div class="vg-foot">
      ${notaVivinoBadge(v)}${v.id<0?catTensHTML(v,true):''}
    </div>
    ${trechosMatch(v,termos)}
  </article>`;
}
/* Lista ou grelha. A escolha guarda-se (é uma preferência de quem usa, não
   um estado do ecrã) e é ORTOGONAL ao agrupamento: os grupos de região,
   ano ou casta continuam a ser os mesmos, só muda o que está dentro
   deles. Mesmo nome e mesmo desenho que o Catálogo da WineCatalog. */
let DET_VISTA='lista';
try{DET_VISTA=localStorage.getItem('gf_det_vista')==='grelha'?'grelha':'lista';}catch(e){}
// Só as classes dos botões. É preciso à parte porque esta preferência
// ATRAVESSA sessões, ao contrário do agrupamento: o HTML nasce com "Lista"
// ligada e quem tinha deixado a grelha via os dois botões a mentir.
function detVistaBotoes(){
  document.getElementById('seg-lista').classList.toggle('on',DET_VISTA==='lista');
  document.getElementById('seg-grelha').classList.toggle('on',DET_VISTA==='grelha');
}
function detVista(modo){
  DET_VISTA=modo;
  try{localStorage.setItem('gf_det_vista',modo);}catch(e){}
  detVistaBotoes();
  renderDetalhe();
}
// A lista completa, organizada por região, ano ou casta — e, quando a
// procura tem alguma coisa ligada, só os vinhos que passam nela (a mesma
// organização, com menos vinhos dentro).
function renderDetalhe(){
  const box=document.getElementById('detalhe-grupos');
  if(!box)return;
  const filtrando=haFiltros();
  const res=filtrando?vinhosFiltrados():vinhosBase();
  const termos=termosProcura();
  const nGar=res.reduce((s,v)=>s+stockDe(v.id),0);
  if(modoCat()){
    document.getElementById('det-count').innerHTML=
      `${res.length} vinho${res.length===1?'':'s'}<span class="det-gar"> no catálogo</span>`;
    if(!CAT_VINHOS){box.innerHTML='<div class="vazio"><b>A abrir o catálogo…</b></div>';return;}
    if(!res.length){box.innerHTML='<div class="vazio"><b>Nada encontrado</b>Nenhum vinho do catálogo corresponde a esta procura.</div>';return;}
  }
  /* As GARRAFAS vão num `<span>` próprio porque no telemóvel desaparecem
     (ver `.det-gar` no style.css): a barra tem de caber numa linha, e
     "170 vinhos · 210 garrafas" não cabia ao lado dos comandos. O número
     que fica é o dos VINHOS, que é o que a lista mostra; as garrafas
     continuam à vista no painel da procura logo acima. */
  if(!modoCat())document.getElementById('det-count').innerHTML=
    `${res.length} vinho${res.length===1?'':'s'}`+
    `<span class="det-gar"> · ${nGar} garrafa${nGar===1?'':'s'}</span>`;
  if(!res.length){
    box.innerHTML=filtrando
      ?'<div class="vazio"><b>Nada encontrado</b>Nenhum vinho corresponde a esta procura.</div>'
      :'<div class="vazio"><b>Ainda sem vinhos</b>Toca no + para pôr o primeiro.</div>';
    return;
  }
  const grupos=agruparVinhos(res,DET_AGRUPAR);
  const grelha=DET_VISTA==='grelha';
  box.innerHTML=grupos.map(g=>{
    const itens=g.vinhos.map(v=>(grelha?vinhoGrelhaHTML:vinhoCardHTML)(v,termos,LOTE_SEL_MODO&&!modoCat())).join('');
    return `<div class="dgrupo">
      <div class="dgrupo-tit">${esc(g.titulo)} <span class="dgrupo-n">${g.vinhos.length}</span></div>
      ${grelha?`<div class="vgrelha">${itens}</div>`:itens}
    </div>`;
  }).join('');
}

// Dispatcher chamado depois de QUALQUER mutação (guardar, apagar, consumir,
// mover…): atualiza os três sítios que mostram vinhos, sem se preocupar com
// qual separador está aberto — o dataset é pequeno, refazer os três é mais
// simples e mais seguro do que tentar adivinhar o que precisa de mudar.
/* Os separadores que só aparecem quando fazem falta (30/09/2026, o dono):
   Locais só com um local DESENHADO (sem desenho não há estante para ver,
   e não se muda uma garrafa de local — `moverPermitido`); Consumidos só
   com garrafas bebidas. Se o separador aberto desaparecer, volta-se ao
   Resumo. */
function temLocaisDesenhados(){return db.locais.some(temLayoutLocal);}
function temConsumidos(){return db.garrafas.some(g=>g.estado==='consumida');}
function sincronizarTabs(){
  const semL=!temLocaisDesenhados(), semC=!temConsumidos();
  document.body.classList.toggle('sem-locais',semL);
  document.body.classList.toggle('sem-consumidos',semC);
  // As Sugestões (a WineSelection, no catálogo) usam IA: sem ela, não há
  // separador — carregar em "Sugerir" para ouvir "não tens acesso" não serve.
  const semS=!podeUsarIA();
  document.body.classList.toggle('sem-sugestoes',semS);
  if((semL&&tabAtiva==='locais')||(semC&&tabAtiva==='consumidos'))
    tab('garrafeira',document.querySelector('.itabs .it'));
  if(semS&&tabAtiva==='sugestoes')
    tab('detalhe',document.querySelector(`.itabs .it[onclick^="tab('detalhe'"]`));
}
function renderLista(){
  sincronizarTabs();
  renderResumo();
  renderFiltrados();
  if(tabAtiva==='desejos')renderDesejos();
  fabSincronizar();
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
function capacidadeLocal(l){return lugaresLocal(l);}
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
/* Duas madeiras, e é o FORMATO que escolhe: uma prateleira de uma fila
   leva a régua com berços (`ondaBgSVG`) porque é nela que a garrafa
   assenta deitada; uma de garrafas SOBREPOSTAS leva uma tábua lisa. As
   duas tinham a régua, e nos sobrepostos ela dizia meia verdade: o berço
   vai só sob a fila de baixo (as de cima assentam nas de baixo), e uma
   fila com berços debaixo de outra sem eles lia-se como uma prateleira
   inacabada. Num frigorífico — o móvel que este formato representa — a
   garrafa assenta é numa prateleira lisa, e é isso que a tábua diz.
   As duas partilham a cor e a espessura, para continuar a ler-se como o
   mesmo móvel. */
function estanteHTML(p,info,slotsHTML,cls){
  const regua=!!(p&&p.ondulada);
  const tabua=regua&&info.formato==='sobrepostos';
  return `<div class="est est-${info.formato}${regua?' est-regua':''}${tabua?' est-lisa':''}${info.desenc?' desenc':''}${cls?' '+cls:''}"
    style="--cols:${info.cols};--colsw:${info.colsw};--gcols:${info.gridCols};--span:${info.span}">${
    regua?(tabua?'<span class="est-bg-l" aria-hidden="true"></span>':ondaBgSVG(info)):''}${slotsHTML}</div>`;
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

   O fundo do berço é um ASSENTO reto e não duas curvas a juntarem-se num
   ponto: uma onda de seno (ou um V, mesmo muito aberto) punha a garrafa a
   assentar num ponto só, e o que segura uma garrafa é o berço inteiro.
   As paredes sobem desse assento e o que sobra entre dois berços é a
   crista.

   A tira atravessa o móvel INTEIRO (a caixa é sempre da largura do
   local), mas os berços têm de cair sob os lugares — que estão centrados
   nela e podem estar desviados meia coluna. Daí a conta do `off`. */
function ondaBgSVG(info){
  /* A régua é uma TIRA colada ao fundo da caixa, com altura própria em
     `--slot` (ver `.est-bg`) — não `inset:0`. Assim o berço cai sempre à
     mesma distância do fundo da garrafa, quer a prateleira tenha uma fila
     (`fila`) ou duas (`sobrepostos`, que é o dobro da altura). Com o SVG
     esticado à caixa inteira, o mesmo `viewBox` dava alturas diferentes
     conforme o formato e os berços fugiam dos lugares. */
  const colsw=info.colsw||info.cols,SEAT=57,ESP=86;
  const larg=100/colsw;                          // uma coluna, em % da caixa
  /* Os berços vão sob a fila de BAIXO e só sob ela: é nela que as garrafas
     assentam na madeira. Nos `sobrepostos`, as de cima assentam nas de
     baixo — dar-lhes berço era desenhar uma prateleira que não existe. */
  const fundo=info.slots.reduce((m,s)=>Math.max(m,s.row),1);
  const cxs=info.slots.filter(s=>s.row===fundo&&!s.encosto)
    .map(s=>((s.col-1+(s.span||1)/2)/2)*larg)     // meias-colunas → % da caixa
    .sort((a,b)=>a-b);
  if(!cxs.length)return '';
  const f=n=>n.toFixed(2);
  /* A régua acaba logo a seguir ao último berço e não na borda da caixa.
     Atravessar o móvel todo dava-lhe dois troços retos e compridos, um de
     cada lado — e o que se lia era uma linha contínua a ir do nome do
     nível até ao outro extremo da linha, não uma prateleira. */
  const PONTA=.24;                               // o que sobra depois do berço, em colunas
  /* O berço tem TRÊS partes: uma zona de contacto RETA no fundo
     (`ASSENTO`), onde a garrafa assenta de facto, e duas paredes
     (`PAREDE`) que sobem dela até à crista. Antes as duas curvas
     juntavam-se no centro e, mesmo com as tangentes quase horizontais, o
     fundo continuava a ser um V muito aberto: a garrafa tocava-lhe num
     ponto e lia-se pousada em cima da régua, não deitada dentro dela.

     A BOCA do berço (assento + duas paredes) tem de ser MAIOR do que a
     garrafa, e a garrafa mede `1/colr` colunas — no espaçamento mais
     apertado (`COL_MIN`) são 0,85 da coluna. Daí a boca sair do próprio
     `COL_MIN` com uma folga, e não de um valor a meio da gama: as paredes
     são o desenho todo, e a meio da gama metade dos casos punha-as
     inteiramente ATRÁS do círculo do lugar (que é opaco e vem por cima,
     ver `.msdot`) — sobrava a crista reta e a régua voltava a ler-se como
     uma tábua contínua. E é o caso mais comum, não o raro: cai-se em
     `COL_MIN` exatamente nos níveis com muitos lugares num ecrã estreito.

     Não se lê o `--colr` a sério aqui de propósito: ele é escrito no `.ml`
     DEPOIS deste SVG existir e sem redesenhar o mapa, por isso um berço
     calculado a partir dele ficaria a discordar do espaçamento no
     primeiro desenho. */
  const BOCA=1.08/COL_MIN;                       // a boca, em colunas: a garrafa mais 8%
  /* A tábua é uma FORMA CHEIA e não dois traços sobre um caminho: o que
     está no móvel é uma prancha de madeira com um berço RECORTADO no
     cimo, debaixo de cada garrafa — e uma régua de 0,2 de espessura,
     por muito que ondule, lê-se como um arame. Cheia, o berço é o
     RECORTE: a garrafa desce para dentro dele e a madeira aparece entre
     as garrafas, que é o que dá o desenho da garrafeira.

     `m` é a meia-boca, `a` o meio-assento (a zona reta onde a garrafa
     toca) e `k` a tangente que arredonda a parede. */
  const m=larg*BOCA/2,a=m*.38,k=m*.28;
  const ini=Math.max(0,cxs[0]-m-larg*PONTA);
  const fim=Math.min(100,cxs[cxs.length-1]+m+larg*PONTA);
  let topo=`M${f(ini)} 0`;
  cxs.forEach(cx=>{
    topo+=` L${f(cx-m)} 0`;                       // o cimo da madeira entre berços
    topo+=` C${f(cx-m+k)} 0 ${f(cx-a-k)} ${SEAT} ${f(cx-a)} ${SEAT}`;
    topo+=` L${f(cx+a)} ${SEAT}`;                 // o assento: onde a garrafa toca
    topo+=` C${f(cx+a+k)} ${SEAT} ${f(cx+m-k)} 0 ${f(cx+m)} 0`;
  });
  topo+=` L${f(fim)} 0`;
  /* O gradiente vive dentro do SVG (um `fill` não aceita gradiente CSS).
     O id repete-se por prateleira — é o mesmo gradiente, e o desenho é
     igual qualquer que seja o que o browser resolva. */
  return `<svg class="est-bg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="est-mad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f8ecd6"/><stop offset=".55" stop-color="#efdcbb"/><stop offset="1" stop-color="#e4cba2"/>
    </linearGradient></defs>
    <path class="est-tab" d="${topo} L${f(fim)} 100 L${f(ini)} 100 Z"/>
    <path class="est-tab-esp" d="M${f(ini)} ${ESP} L${f(fim)} ${ESP} L${f(fim)} 100 L${f(ini)} 100 Z"/>
    <path class="est-tab-borda" d="${topo}"/>
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
/* AS PAREDES são desenhadas UMA VEZ para a estante toda e não nível a
   nível: o que está no móvel é uma parede contínua, e uma tira por linha
   dava uma linha picada (as linhas têm margens entre si, e o ziguezague
   até margens negativas). Ficam num `.ml-est` em posição relativa, e o x
   sai de medir a estante depois de ela existir (ver `posicionarParedes`)
   — todas as prateleiras têm a MESMA largura, por isso a parede fica
   naturalmente ao nível das mais compridas e as curtas deixam o vão à
   vista, como no móvel. */
function mapaEstanteHTML(l,gs,d){
  const prats=prateleirasDesc(layoutLocal(l));
  const occ=ocupacaoLayout(l.id);
  const par=paredesLocal(l);
  const topo=prateleiraTopo(l);
  const linhaHTML=p=>{
    const info=prateleiraLayoutInfo(p);
    const slots=info.slots.map(s=>{
      const k=String(s.lugar),lista=occ[k]||[];
      const pos=` style="${slotGridStyle(s)}"`;
      const extra=(s.encosto?' encosto encosto-'+s.encosto:'')+(s.topo?' emcima':'');
      if(!lista.length)return `<button class="msdot vazia${extra}"${pos}
        onclick="mapaLugarVazio(${l.id},'${escJs(p.nome)}','${escJs(k)}')"
        title="${esc(posicaoTxt(p.nome,k))} — vazio"><span class="msdot-id">${esc(k)}</span></button>`;
      const passam=d.filtrando?lista.filter(g=>d.okG.has(g.id)):lista;
      const g=passam[0]||lista[0],v=IDXV[g.vinho_id]||{nome:'?'};
      /* A procura tem de se ver no DESENHO e não só na contagem do
         cabeçalho: `achada` é o que passa (arco à volta), `fora` o que
         está ocupado por garrafa que não passa (apagado). Ver "O LUGAR
         DURANTE A PROCURA" no style.css. */
      const achada=d.filtrando&&passam.length>0;
      // a moldura de madeira é da GARRAFA (`caixa_madeira`): um quadrado
      // de madeira na mesma célula, por trás do círculo
      const cx=g.caixa_madeira?`<span class="mscx" aria-hidden="true"${pos}></span>`:'';
      return `${cx}<button class="msdot cheia${lista.length>1?' conflito':''}${achada?' achada':''}${d.filtrando&&!passam.length?' fora':''}${extra}"${pos}
        onclick="mapaPopupToggle(${l.id},'${escJs(p.nome)}','${escJs(k)}',this,event)"
        onmouseenter="mapaPopupHover(${l.id},'${escJs(p.nome)}','${escJs(k)}',this)" onmouseleave="mapaPopupSair()"
        title="${esc(v.nome)} ${v.ano||''} · ${esc(posicaoTxt(p.nome,k))}${g.caixa_madeira?' · em caixa de madeira':''}${lista.length>1?` · ${lista.length} garrafas`:''}">
        <span class="msdot-id">${g.vinho_id}</span>
        ${lista.length>1?`<span class="msdot-q">×${lista.length}</span>`:''}
      </button>`;
    }).join('');
    return `<div class="mprat-layout${p.encaixe?' encaixa':''}${p.topo?' mp-emcima':''}">
      <span class="mp-lbl">${esc(p.nome)}</span>
      <span class="mp-fio"></span>
      <div class="est-wrap">${estanteHTML(p,info,slots,p.topo?'est-topo':'')}</div>
      <span class="mp-esp"></span>
    </div>`;
  };
  const temCaixa=db.garrafas.some(g=>g.local_id===l.id&&naGarrafeira(g)&&g.caixa_madeira);
  /* NÃO HÁ NICHO. Houve — um recesso sombreado de uma coluna, do primeiro
     ao último encosto — para dar chão às garrafas encostadas, que sem ele
     ficavam a flutuar ao lado do móvel. O remédio saiu pior: uma mancha
     cinzenta de vários níveis de altura encostada à borda do ecrã, o
     elemento mais escuro de um separador que é feito de madeira clara, a
     tapar meia estante para dizer "aqui ao lado não há prateleira". As
     garrafas de encosto já se dizem sozinhas — são menores do que um
     lugar do móvel, e a parede atrás delas diz onde estão. */
  return `<div class="ml-est${par.dir?' pd-dir':''}${par.esq?' pd-esq':''}${par.topo?' pd-topo':''}">
    ${par.topo?'<span class="pd-h" aria-hidden="true"></span>':''}
    ${par.dir?'<span class="pd-v dir" aria-hidden="true"></span>':''}
    ${par.esq?'<span class="pd-v esq" aria-hidden="true"></span>':''}
    ${topo?linhaHTML(topo):''}${prats.map(linhaHTML).join('')}
  </div>
  <div class="ml-leg"><span><i class="cheia"></i>Ocupado · nº do vinho</span><span><i class="vazia"></i>Vazio · nº do lugar</span>${
    temCaixa?'<span><i class="cx"></i>Em caixa de madeira</span>':''}${
    (par.dir||par.esq||par.topo)?'<span><i class="pd"></i>Parede</span>':''}</div>`;
}
/* O x das paredes: medido, não calculado. A estante vive numa linha com o
   nome do nível de um lado e um espaçador do outro, e a largura do lugar
   é escolhida a correr (`ajustarEstantes`) — refazer essa conta aqui era
   ficar a discordar dela. Mede-se a caixa da estante e diz-se à parede
   onde parar. */
function posicionarParedes(){
  const box=document.getElementById('mapa');
  const est=box&&box.querySelector('.ml-est');
  if(!est)return;
  const ests=est.querySelectorAll('.est');
  const e=ests[ests.length-1];
  if(!e)return;
  const a=est.getBoundingClientRect(),b=e.getBoundingClientRect();
  est.style.setProperty('--pd-l',Math.max(0,b.left-a.left).toFixed(1)+'px');
  est.style.setProperty('--pd-r',Math.max(0,a.right-b.right).toFixed(1)+'px');
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
  return `<div class="ml${d.filtrando?' procurando':''}" style="--lc:${esc(l.cor||'#7b1f3d')}">
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
/* Quanto mede uma coluna, em lugares. `COL_MIN` é o espaçamento apertado
   (garrafas quase a tocarem-se, que é o que o encaixe precisa) e `COL_MAX`
   o folgado. Vive aqui, fora do `ajustarEstantes`, porque a `ondaBgSVG`
   também precisa dele: a boca do berço tem de ser maior do que a garrafa
   no caso mais apertado. */
const COL_MIN=1.18, COL_MAX=1.36;
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
window.addEventListener('resize',()=>{clearTimeout(_estT);_estT=setTimeout(()=>{ajustarEstantes();posicionarParedes();},120);});

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
  posicionarParedes();
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
        ${img?`<img src="${esc(img)}" alt="" loading="lazy" onload="fotoCarregou(this)" onerror="this.remove()">`:''}
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
  db.garrafas.filter(g=>naGarrafeira(g)&&!chaveLugarLayout(g.lugar))
    .forEach(g=>{soltas[g.vinho_id]=(soltas[g.vinho_id]||0)+1;});
  const ordenados=db.vinhos.filter(v=>!desejado(v)).sort((a,b)=>
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
      <button class="btn prim" id="lv-btn" onclick="guardarLugarVazio(${localId},'${escJs(prateleira)}','${escJs(String(lugar))}')">Guardar</button>
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
  const solta=db.garrafas.filter(g=>naGarrafeira(g)&&g.vinho_id===vinhoId&&!chaveLugarLayout(g.lugar))
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
   o estado e carimba data/sítio/notas, e é esta lista que os mostra.
   Um vinho muda ao longo de uma refeição — por isso as notas são VÁRIAS
   (`consumo_notas`, uma linha por comentário), não um campo só que a
   última edição apagava a anterior. A hora só aparece quando há mais do
   que uma: com uma só, é a data do cartão que já diz quando foi. */
function notasConsumoHTML(g){
  const ns=g.notas||[];
  if(!ns.length)return '';
  const comHora=ns.length>1;
  return `<div class="cc-notas">${ns.map(n=>
    `<div class="cc-nota">${comHora?`<b>${esc(dataHoraLocal(n.criado_em).slice(11))}</b> `:''}"${esc(n.nota)}"</div>`
  ).join('')}</div>`;
}
function renderConsumidos(){
  const gs=db.garrafas.filter(g=>g.estado==='consumida')
    .sort((a,b)=>String(b.consumido_em||'').localeCompare(String(a.consumido_em||'')));
  const ano=new Date().getFullYear();
  const nEsteAno=gs.filter(g=>String(g.consumido_em||'').startsWith(String(ano))).length;
  const notas=gs.filter(g=>g.consumo_avaliacao);
  const media=notas.length?(notas.reduce((s,g)=>s+Number(g.consumo_avaliacao),0)/notas.length):0;
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
      ${g.consumo_avaliacao?`<div class="estrelas">${estrelas(g.consumo_avaliacao)}<b class="aval-n">${avalFmt(g.consumo_avaliacao)}</b></div>`:''}
      ${notasConsumoHTML(g)}
      <div class="macoes ro-hide" style="margin-top:10px">
        <button class="mini" onclick="editarConsumo(${g.id})">✎ Editar</button>
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
let _catBaseNovo=null;   // os valores que o catálogo mostrou no vinho novo (curadores)
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
  // Pede-se a comparação DEPOIS de a ficha já estar no ecrã — nunca antes,
  // que o catálogo é uma poupança e um espelho, nunca uma dependência no
  // caminho de abrir um vinho. A marca aparece quando a resposta chegar.
  if(id>0)catComparar(id);
  else catNotaPintar();
}
function refrescarVinhoAberto(){
  if(VINHO_ABERTO!=null&&document.getElementById('modal-vinho').classList.contains('on')){
    const v=IDXV[VINHO_ABERTO];
    // Refazer o HTML deita fora o cabeçalho (e com ele as medidas do
    // encolher), mas o scroll fica onde estava — daí o acerto a seguir.
    if(v){document.getElementById('modal-vinho-in').innerHTML=vinhoDetalheHTML(v);pgMedirEncolhe();if(v.id<0)catNotaPintar();}
  }
}


/* ══════════════════════════════════════════════════════════════════
   O ESPELHO DO CATÁLOGO

   Esta garrafeira alimenta um catálogo partilhado (ver
   `db/catalogo-partilhado.sql`) que a WineSelection também lê e escreve. Até
   aqui a relação era de sentido único: escrevia-se e nunca se ouvia nada de
   volta. Isso deixava a avaria mais chata de todas sem sítio nenhum onde
   aparecer — o MESMO vinho com números diferentes nos dois lados, e ninguém
   a saber qual está certo.

   Agora, ao abrir um vinho, pergunta-se ao catálogo o que é que ele tem de
   diferente. Os campos que não batem certo ganham uma marca, e cada um tem
   duas saídas — porque são mesmo duas situações diferentes:

     · "o catálogo está certo"  -> traz-se o valor de lá para cá;
     · "o errado é o catálogo"  -> avisa-se o admin dele, que corrigir só
       aqui deixava o erro lá, e portanto deixava-o a toda a gente.

   A COMPARAÇÃO NÃO INVENTA DIFERENÇAS: quem decide se dois valores são
   diferentes é a `winecatalog.igual`, no SQL — "Tinto" e "tinto" não são,
   13.5 e 13.50 não são, e as mesmas castas por outra ordem também não. Uma
   marca a aparecer em metade dos campos no primeiro dia era uma marca que
   ninguém voltava a olhar.

   NUNCA DEITA A FICHA ABAIXO. O catálogo pode não responder (ou nem
   existir, numa base montada só com este repo) e isso não é um erro para
   quem está a abrir um vinho: é não haver nada para comparar. Toda a gente
   aqui engole o erro de propósito — mesma regra do trigger.
   ══════════════════════════════════════════════════════════════════ */
let CAT_CMP={};        // vinho_id -> resposta da comparação
let CAT_ACARREGAR={};  // vinho_id -> true enquanto vai a caminho

/* Os campos do catálogo pelo nome que têm no ecrã — e, ao mesmo tempo, os
   ÚNICOS que se comparam. São exatamente os que a `ficha_catalogo` manda e
   o `aplicar_do_catalogo` sabe gravar. O catálogo guarda mais do que isso
   (`ano`, `produtor`, `precos`, escritos por outros scripts), e mostrá-los
   aqui era pior do que inútil: do nosso lado nunca estão na ficha, por isso
   apareciam SEMPRE como "o catálogo sabe e tu não" — o produtor igual ao
   meu, o ano de uma colheita que não é a minha, `precos` como
   [object Object] — e "Usar a do catálogo" dizia "3 campos trazidos ✓" sem
   mudar nada. O ano e o produtor são a IDENTIDADE do vinho (é por eles que
   se acha a linha do catálogo), não factos para trazer de lá. Um campo novo
   do outro lado entra aqui no dia em que a `ficha_catalogo` o souber
   escrever. */
const CAT_NOMES={
  tipo:'Tipo',estilo:'Estilo',mencao:'Menção',classificacao:'Classificação',
  castas:'Castas',regiao:'Região',sub_regiao:'Sub-região',pais:'País',
  teor:'Álcool',estagio_meses:'Estágio (meses)',estagio_texto:'Estágio',
  vivino_nota:'Nota Vivino (colheita)',vivino_avaliacoes:'Avaliações Vivino (colheita)',
  vivino_nota_global:'Nota Vivino (todas as colheitas)',
  vivino_avaliacoes_global:'Avaliações Vivino (todas as colheitas)',
  vivino_url:'Link do Vivino',preco_medio:'Preço de referência',
  beber_de:'Beber de',beber_ate:'Beber até',notas_prova:'Notas de prova',
  harmonizacao:'Harmoniza com',ai_resumo:'Resumo',imagem_url:'Imagem'
};
function catNome(k){return CAT_NOMES[k]||k;}

/* De onde veio o valor que está no catálogo. A mesma legenda da app do
   catálogo — e a mesma distinção que lá custou semanas a aparecer: quem
   tem a garrafa na mão sabe o que está no RÓTULO, mas a nota do Vivino e o
   preço leu-os em algum lado como toda a gente. */
function catOrigemTxt(o,f){
  if(o==='garrafeira'&&Number(f)===2)return 'outra garrafeira (nota/preço copiados)';
  return ({
    'garrafeira':'outra garrafeira (garrafa na mão)',
    'garrafeira-bruto':'outra garrafeira (escrito à pressa)',
    'garrafeira-desejo':'a wishlist de uma garrafeira',
    'catalogo-admin':'corrigido à mão pelo admin do catálogo',
    'catalogo-pesquisa':'pesquisa Google pedida no catálogo',
    'ws-verificacao':'verificação com pesquisa Google',
    'ws-sugestao':'sugestão de uma carta (com pesquisa)',
    'vinho-info-premium':'procura da Garrafeira (grounding)',
    'vinho-info-gratis':'procura da Garrafeira (pesquisa + extração)',
    // Os scripts da WineCatalog, que leem a página do vinho no Vivino e nas
    // lojas: o preço de referência que vem daqui diz de que loja é.
    'vivino-pagina':'página do Vivino',
    'lojas-script':'preços das lojas',
    'loja-garrafeira-nacional':'Garrafeira Nacional',
    'loja-granvine':'Granvine',
    'loja-vinha':'Vinha'
  })[o]||(o||'(sem origem)');
}
function catValTxt(v){
  if(v==null)return '—';
  if(Array.isArray(v))return v.join(', ');
  return String(v);
}

/* Chamado pelo `verVinho`. Não bloqueia a abertura da ficha: ela desenha-se
   já e a marca aparece quando a resposta chegar. Uma ficha à espera do
   catálogo para abrir era pôr uma poupança no caminho crítico. */
async function catComparar(id,forcar){
  if(!id)return;
  if(!forcar&&(CAT_CMP[id]||CAT_ACARREGAR[id]))return;
  CAT_ACARREGAR[id]=true;
  try{
    const r=await sbRpc('comparar_catalogo',{p_vinho_id:id});
    CAT_CMP[id]=r||{encontrado:false};
  }catch(e){
    CAT_CMP[id]={encontrado:false,semCatalogo:true};
  }finally{
    delete CAT_ACARREGAR[id];
  }
  if(VINHO_ABERTO===id)refrescarVinhoAberto();
}

function catDados(id){return CAT_CMP[id]||null;}
function catCampos(id){
  const d=catDados(id);
  return (d&&d.encontrado&&Array.isArray(d.campos))
    ?d.campos.filter(c=>c&&Object.prototype.hasOwnProperty.call(CAT_NOMES,c.campo)):[];
}
function catDiferentes(id){return catCampos(id).filter(c=>c.difere);}
function catSoCatalogo(id){return catCampos(id).filter(c=>c.soCatalogo);}

/* A marquinha que vai ao lado do valor na ficha. Discreta de propósito: é
   um aviso, não um erro — e na esmagadora maioria dos vinhos não aparece
   de todo. */
function catMarca(id,campos){
  const ks=Array.isArray(campos)?campos:[campos];
  const dif=catDiferentes(id).filter(c=>ks.includes(c.campo));
  if(!dif.length)return '';
  return `<button class="cat-marca" onclick="catAbrirPainel(${id},'${escJs(dif[0].campo)}')"
    title="O catálogo partilhado tem outro valor para isto">≠ catálogo</button>`;
}

/* A tira por baixo dos botões: o resumo, para quem não vai ler a ficha
   toda. Some quando não há nada a dizer. */
function catTiraHTML(v){
  const d=catDados(v.id);
  if(!d)return '';
  if(!d.encontrado)return '';
  const dif=catDiferentes(v.id), so=catSoCatalogo(v.id);
  if(!dif.length&&!so.length)return '';
  const partes=[];
  if(dif.length)partes.push(`<strong>${dif.length}</strong> campo${dif.length>1?'s':''} não bate${dif.length>1?'m':''} certo`);
  if(so.length)partes.push(`o catálogo sabe mais <strong>${so.length}</strong>`);
  return `<div class="cat-tira${dif.length?' dif':''}" onclick="catAbrirPainel(${v.id})">
    <span class="cat-tira-i">${dif.length?'≠':'+'}</span>
    <span>${partes.join(' · ')}${d.mesmaColheita?'':' <em>(o catálogo tem outra colheita)</em>'}</span>
    <span class="cat-tira-v">ver</span>
  </div>`;
}

/* O painel. Cada campo com os DOIS valores lado a lado e as duas saídas —
   e a origem do valor do catálogo por baixo, que é o que permite decidir
   sem ter de acreditar: uma "verificação com pesquisa Google" e um
   "escrito à pressa" não pedem a mesma reação. */
function catAbrirPainel(id,focar){
  const v=IDXV[id];
  const d=catDados(id);
  if(!v||!d)return;
  const dif=catDiferentes(id), so=catSoCatalogo(id);
  const podeMexer=podeEditar();

  let h=`<div class="mtop"><h3>O que o catálogo diz</h3>
    <button class="mx" onclick="fecharModal('modal-catalogo')">✕</button></div>
  <p class="note">O catálogo é a memória partilhada com a WineSelection: o que uma
    já pesquisou, a outra aproveita. Isto compara a <strong>tua</strong> ficha com a que
    lá está.${d.mesmaColheita?'':` <strong>Atenção:</strong> a linha do catálogo é da colheita
    ${d.ano?esc(String(d.ano)):'sem ano'}, não da tua — os factos do vinho servem, a nota e o
    preço são da colheita dele.`}</p>`;

  if(!dif.length&&!so.length){
    h+='<p class="note">Está tudo igual. Nada a fazer.</p>';
  }

  if(dif.length){
    h+=`<div class="msec">Não batem certo (${dif.length})</div>`;
    h+=dif.map(c=>catCampoHTML(id,c,podeMexer,focar===c.campo,false)).join('');
  }
  if(so.length){
    h+=`<div class="msec">O catálogo sabe e tu não (${so.length})</div>
      <p class="note">Isto não é um desacordo — é informação que te falta. Trazê-la não apaga nada.</p>`;
    h+=so.map(c=>catCampoHTML(id,c,podeMexer,focar===c.campo,true)).join('');
    if(podeMexer&&so.length>1){
      // Os nomes dos campos vêm de `CAT_NOMES` — só letras, dígitos e
      // sublinhado, nunca texto do utilizador — por isso um array literal
      // aqui não precisa de escape nenhum.
      const lista="['"+so.map(c=>c.campo).join("','")+"']";
      h+=`<button class="btn ghost" onclick="catAplicar(${id},${lista})">
        ⬇ Trazer os ${so.length} de uma vez</button>`;
    }
  }
  h+=`<div class="macoes"><button class="btn ghost" onclick="fecharModal('modal-catalogo')">Fechar</button></div>`;
  document.getElementById('modal-catalogo-in').innerHTML=h;
  abrirModal('modal-catalogo');
  if(focar){
    const el=document.querySelector('#modal-catalogo-in .cat-cmp.focado');
    if(el)el.scrollIntoView({block:'center'});
  }
}

function catCampoHTML(id,c,podeMexer,focado,soDeles){
  const f=Number(c.forca||0);
  return `<div class="cat-cmp${focado?' focado':''}">
    <div class="cat-cmp-k">${esc(catNome(c.campo))}</div>
    <div class="cat-cmp-v">
      ${soDeles?'':`<div class="lado meu"><span>o teu</span><b>${escLink(catValTxt(c.meu))}</b></div>`}
      <div class="lado deles"><span>no catálogo</span><b>${escLink(catValTxt(c.catalogo))}</b>
        <i class="cat-de f${esc(String(f))}">${esc(catOrigemTxt(c.origem,f))}</i></div>
    </div>
    <div class="cat-cmp-a">
      ${podeMexer?`<button class="mini" onclick="catAplicar(${id},['${escJs(c.campo)}'])">⬇ Usar a do catálogo</button>`:''}
      ${soDeles?'':`<button class="mini o" onclick="catReportar(${id},'${escJs(c.campo)}')">⚠ O errado é o catálogo</button>`}
    </div>
  </div>`;
}

/* Trazer para cá. Substitui SÓ os campos pedidos — nunca "sincroniza
   tudo": a ficha de um vinho nesta app tem coisas que são de quem a tem (as
   notas, a foto, o preço pago) e o botão que traz tudo é o botão que um dia
   as apaga sem ninguém perceber. */
async function catAplicar(id,campos){
  if(!Array.isArray(campos)||!campos.length)return;
  try{
    const r=await sbRpc('aplicar_do_catalogo',{p_vinho_id:id,p_campos:campos});
    toast(`${(r&&r.campos)||0} campo(s) trazidos do catálogo ✓`);
    fecharModal('modal-catalogo');
    await carregarGarrafeira();
    await catComparar(id,true);
    refrescarVinhoAberto();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* Avisar o admin do catálogo. O valor que segue é o que ESTÁ na ficha
   (tirado da mesma tradução que alimenta o catálogo), não texto escrito
   numa caixa: assim o outro lado vê os dois números, não uma descrição
   deles. A caixa é só para o contexto — onde é que viste o outro valor. */
async function catReportar(id,campo){
  const nota=prompt(
    'Avisar o admin do catálogo de que este campo está errado lá.\n\n'+
    'O teu valor e o do catálogo seguem automaticamente. Queres acrescentar\n'+
    'alguma coisa? (ex.: onde é que viste o valor certo)');
  if(nota===null)return;
  try{
    const r=await sbRpc('reportar_ao_catalogo',{p_vinho_id:id,p_campo:campo,p_nota:nota||null});
    toast(r&&r.noCatalogo?'Avisado ✓ o admin do catálogo vai ver isto'
                         :'Avisado ✓ (este vinho ainda não está no catálogo)');
  }catch(e){toast('Erro: '+e.message,1);}
}

/* ══════════════════════════════════════════════════════════════════
   COMENTÁRIOS E SUGESTÕES

   Duas conversas com o admin, pelo mesmo caminho (a migração 26 daqui e o
   `db/comentarios.sql` do WineCatalog — é lá que ele as lê, em Alertas e no
   painel do PC):
     · um COMENTÁRIO SOBRE UM VINHO, da página dele ("Algo não está bem?"):
       atributos que não estão bem, um site de onde atualizar a ficha, outro
       problema. Não é o "⚠ O errado é o catálogo" do espelho de cima: esse
       só aparece quando a comparação vê um campo diferente, e o caso mais
       comum é o catálogo e a garrafeira estarem IGUAIS e errados (foi de lá
       que o erro veio). Corrigido no catálogo, chega a toda a gente;
     · uma SUGESTÃO sobre a app, de Definições.
   Os valores dos atributos escolhidos seguem da BD (`comentar_vinho`), não
   do que se escreve na caixa. Quem vê o vinho pode comentar — mesmo numa
   garrafeira emprestada, como no reportar: por isso nada disto é `ro-hide`.
   A CONVERSA vive em Definições › Sugestões e comentários: o admin pode
   fechar com uma resposta ou devolver uma PERGUNTA (`duvida` — a vez passa
   a quem escreveu), e quem escreveu responde daí. Chega-se lá por três
   avisos, do mais forte ao mais fraco: o push no telemóvel (migração 27),
   o toast à entrada e o número no ⚙️ (`comentariosAvisos`).
   ══════════════════════════════════════════════════════════════════ */
const COM_MOTIVOS_VINHO=[
  ['atributos','Há atributos que não estão bem','Ex.: as castas são Touriga Nacional e Touriga Franca, não Syrah.'],
  ['atualizar','Atualizar a partir de um site','Opcional — ex.: a página tem as notas de prova e o estágio.'],
  ['outro','Outro problema','Conta o que se passa com este vinho.']
];
const COM_MOTIVOS_SUG=[
  ['melhoria','Uma ideia / melhoria','Ex.: dava jeito ordenar a lista pelo preço.'],
  ['problema','Algo não funciona','O que fizeste, o que esperavas e o que aconteceu.']
];
const COM_MOTIVO_TXT=Object.fromEntries([...COM_MOTIVOS_VINHO,...COM_MOTIVOS_SUG].map(([k,t])=>[k,t]));
/* Os atributos que se podem apontar, pelo nome que têm na ficha — cada um
   com os campos que estão por trás (a nota do Vivino são quatro). */
const COM_CAMPOS=[
  ['Nome',['nome']],['Produtor',['produtor']],['Ano',['ano']],
  ['Cor / estilo',['tipo','estilo']],['Menção',['mencao']],['Classificação',['classificacao']],
  ['Castas',['castas']],['Região',['regiao','sub_regiao']],['Álcool',['teor']],
  ['Estágio',['estagio_meses','estagio_texto']],
  ['Nota do Vivino',['vivino_nota','vivino_avaliacoes','vivino_nota_global','vivino_avaliacoes_global']],
  ['Link do Vivino',['vivino_url']],['Preço',['preco_medio']],['Beber entre',['beber_de','beber_ate']],
  ['Notas de prova',['notas_prova']],['Harmoniza com',['harmonizacao']],['Imagem',['imagem_url']]
];
const COM_ESTADO={aberto:'por ver',duvida:'pergunta para ti',resolvido:'tratado',rejeitado:'recusado'};
let COM_MEUS=null, COM_A_LER=false, COM_AVISOS=null, COM_RESP_ABERTA=null;

function comModal(h){document.getElementById('modal-comentario-in').innerHTML=h;abrirModal('modal-comentario');}
function comBotoes(acao){
  return `<div class="macoes">
      <button class="btn prim" id="cm-btn" onclick="${acao}">Enviar</button>
      <button class="btn ghost" onclick="fecharModal('modal-comentario')">Cancelar</button>
    </div>`;
}
function abrirComentario(vinhoId){
  const v=IDXV[vinhoId];if(!v)return;
  comModal(`<div class="mtop"><h3>💬 Algo não está bem?</h3>
      <button class="mx" onclick="fecharModal('modal-comentario')">✕</button></div>
    <p class="note"><b>${esc(v.nome)}</b>${v.ano?' · '+v.ano:''}${v.produtor?' · '+esc(v.produtor):''}. Vai para o
      admin do catálogo, que corrige o vinho lá — e daí chega às garrafeiras, a tua incluída. A resposta
      aparece em Definições › Sugestões e comentários.</p>
    <label>O que se passa</label>
    <select id="cm-motivo" onchange="comMotivo()">${COM_MOTIVOS_VINHO.map(([k,t])=>`<option value="${k}">${esc(t)}</option>`).join('')}</select>
    <div id="cm-campos-box"><label>Que atributos (opcional)</label>
      <div class="cm-campos">${COM_CAMPOS.map(([t],i)=>`<label class="ll-enc"><input type="checkbox" class="cm-campo" data-i="${i}"><span>${esc(t)}</span></label>`).join('')}</div></div>
    <label id="cm-link-l">Link (opcional)</label>
    <input type="url" id="cm-link" inputmode="url" autocomplete="off" placeholder="https://… a página do vinho numa loja ou no produtor">
    <label>Comentário</label>
    <textarea id="cm-texto" maxlength="2000"></textarea>
    ${comBotoes(`enviarComentario(${v.id})`)}`);
  comMotivo();
}
function abrirSugestao(){
  comModal(`<div class="mtop"><h3>💡 Uma sugestão</h3>
      <button class="mx" onclick="fecharModal('modal-comentario')">✕</button></div>
    <p class="note">Uma ideia para a app, ou alguma coisa que não funciona como devia. Vai para o admin; a
      resposta aparece aqui, em Definições.</p>
    <label>O que é</label>
    <select id="cm-motivo" onchange="comMotivo()">${COM_MOTIVOS_SUG.map(([k,t])=>`<option value="${k}">${esc(t)}</option>`).join('')}</select>
    <label>Conta</label>
    <textarea id="cm-texto" maxlength="2000" style="min-height:120px"></textarea>
    ${comBotoes('enviarSugestao()')}`);
  comMotivo();
}
/* O motivo muda o que se pede: "atualizar" pede o link (e é ele que diz
   tudo — o texto passa a opcional); "outro problema" não aponta atributos. */
function comMotivo(){
  const m=document.getElementById('cm-motivo').value;
  const d=[...COM_MOTIVOS_VINHO,...COM_MOTIVOS_SUG].find(x=>x[0]===m);
  const tx=document.getElementById('cm-texto');if(tx&&d)tx.placeholder=d[2];
  const cb=document.getElementById('cm-campos-box');if(cb)cb.style.display=m==='outro'?'none':'';
  const ll=document.getElementById('cm-link-l');if(ll)ll.textContent=m==='atualizar'?'Link da página com a informação certa':'Link (opcional)';
}
async function enviarComentario(vinhoId){
  const motivo=document.getElementById('cm-motivo').value;
  const texto=document.getElementById('cm-texto').value.trim();
  const link=document.getElementById('cm-link').value.trim();
  const campos=motivo==='outro'?[]
    :[...document.querySelectorAll('#modal-comentario-in .cm-campo:checked')].flatMap(c=>COM_CAMPOS[+c.dataset.i][1]);
  if(link&&!/^https?:\/\/\S+$/i.test(link)){toast('O link tem de ser um endereço completo, começado por https://',1);return;}
  if(motivo==='atualizar'&&!link){toast('Cola o link da página com a informação certa',1);document.getElementById('cm-link').focus();return;}
  if(motivo!=='atualizar'&&texto.length<3){toast('Escreve o que se passa',1);document.getElementById('cm-texto').focus();return;}
  await comEnviar('comentar_vinho',{p_vinho_id:vinhoId,p_motivo:motivo,p_texto:texto||null,
    p_campos:campos.length?campos:null,p_link:link||null});
}
async function enviarSugestao(){
  const motivo=document.getElementById('cm-motivo').value;
  const texto=document.getElementById('cm-texto').value.trim();
  if(texto.length<3){toast('Escreve a sugestão',1);document.getElementById('cm-texto').focus();return;}
  await comEnviar('sugerir',{p_motivo:motivo,p_texto:texto});
}
async function comEnviar(fn,args){
  const b=document.getElementById('cm-btn');
  if(b){b.disabled=true;b.textContent='A enviar…';}
  try{
    await sbRpc(fn,args);
    fecharModal('modal-comentario');
    toast('Enviado ✓ o admin vai ver isto');
    if(tabAtiva==='cfg')renderMeusComentarios();
  }catch(e){
    if(b){b.disabled=false;b.textContent='Enviar';}
    toast(/Could not find the function|schema cache/i.test(e.message)
      ?'Ainda não está ligado — falta correr a migração 26 no Supabase'
      :'Não foi possível enviar: '+e.message,1);
  }
}
/* Os meus, com a CONVERSA: o que escrevi, cada pergunta ou resposta do
   admin e o que respondi. Só se pedem com Definições à vista (o
   `renderCfg` corre também no arranque e depois de outras mudanças); até
   chegarem, fica o que já se tinha. Sem a migração 26 a lista fica vazia —
   o botão de enviar é que o diz.
   Com a lista à vista, o que o admin disse deixa de estar por ler; o
   realce (`.novo`) fica até ela se voltar a desenhar, que é o que deixa ver
   QUAL era o novo. */
async function renderMeusComentarios(){
  const box=document.getElementById('cfg-comentarios');
  if(!box)return;
  comAdminPintar();
  pushPintar();
  if(COM_MEUS)box.innerHTML=meusComentariosHTML();
  if(COM_A_LER)return;
  COM_A_LER=true;
  try{COM_MEUS=(await sbRpc('meus_comentarios',{}))||[];}
  catch(e){COM_MEUS=COM_MEUS||[];}
  finally{COM_A_LER=false;}
  box.innerHTML=meusComentariosHTML();
  if(COM_MEUS.some(c=>c.porLer)){
    try{await sbRpc('comentarios_lidos',{});}catch(e){}
    comentariosAvisos();
  }
}
function meusComentariosHTML(){
  if(!COM_MEUS||!COM_MEUS.length)return '';
  return `<div class="cm-lista">${COM_MEUS.map(c=>{
    const falas=(c.mensagens||[]).map(comFalaHTML).join('');
    // A caixa de responder abre-se sozinha numa pergunta do admin (é a vez
    // de quem escreveu); nos outros, a um toque — acrescentar alguma coisa,
    // ou "continua mal" depois de tratado (volta à lista do admin).
    const aberta=c.estado==='duvida'||COM_RESP_ABERTA===c.id;
    return `<div class="cm-item${c.porLer?' novo':''}">
      <div class="cm-cab"><b>${c.tipo==='vinho'?esc(c.nome||'')+(c.ano?' '+esc(String(c.ano)):''):'Sugestão'}</b>
        <span class="cm-est ${esc(c.estado)}">${esc(COM_ESTADO[c.estado]||c.estado)}</span></div>
      <i>${esc(COM_MOTIVO_TXT[c.motivo]||c.motivo)} · ${esc(dataPT(c.quando))}</i>
      ${c.texto?`<div class="cm-tx">${esc(c.texto)}</div>`:''}
      ${c.link?`<div class="cm-tx"><a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.link)}</a></div>`:''}
      ${falas?`<div class="cm-fio">${falas}</div>`:''}
      ${aberta?`<div class="cm-rbox">
          <textarea id="cm-r-${c.id}" maxlength="2000" placeholder="${c.estado==='duvida'?'A tua resposta ao admin':'O que queres acrescentar?'}"></textarea>
          <div class="cm-rac"><button class="mini p" id="cm-rb-${c.id}" onclick="comResponderAdmin(${c.id})">Responder</button>
            ${c.estado==='duvida'?'':`<button class="mini" onclick="comRespToggle(${c.id})">Cancelar</button>`}</div>
        </div>`
        :`<button class="cm-mais" onclick="comRespToggle(${c.id})">${c.estado==='aberto'?'Acrescentar alguma coisa':'Responder'}</button>`}
    </div>`;}).join('')}</div>`;
}
function comFalaHTML(m){
  const adm=m.de==='admin';
  const quem=adm?({duvida:'Pergunta do admin',resolvido:'O admin tratou',rejeitado:'O admin respondeu'}[m.estado]||'O admin'):'Tu';
  return `<div class="cm-fala${adm?' adm':''}"><b>${esc(quem)} · ${esc(dataHoraLocal(m.quando))}</b>${m.texto?esc(m.texto):''}</div>`;
}
function comRespToggle(id){
  COM_RESP_ABERTA=COM_RESP_ABERTA===id?null:id;
  const box=document.getElementById('cfg-comentarios');
  if(box)box.innerHTML=meusComentariosHTML();
  const t=document.getElementById('cm-r-'+id);if(t)t.focus();
}
async function comResponderAdmin(id){
  const t=document.getElementById('cm-r-'+id);
  const texto=((t&&t.value)||'').trim();
  if(texto.length<2){toast('Escreve a resposta',1);if(t)t.focus();return;}
  const b=document.getElementById('cm-rb-'+id);
  if(b){b.disabled=true;b.textContent='A enviar…';}
  try{
    await sbRpc('comentario_responder',{p_id:id,p_texto:texto});
    COM_RESP_ABERTA=null;
    toast('Enviado ✓ o admin vai ver isto');
    await renderMeusComentarios();
    comentariosAvisos();
  }catch(e){
    if(b){b.disabled=false;b.textContent='Responder';}
    toast('Não foi possível enviar: '+e.message,1);
  }
}

/* ── OS AVISOS À ENTRADA ──────────────────────────────────────────────
   A rede por baixo do push: o que o admin me disse e ainda não li, as
   perguntas dele à espera da minha resposta e — só ao admin do catálogo —
   os comentários e sugestões por tratar. Pergunta-se uma vez no arranque
   (e depois de cada conversa): dá o número no ⚙️ e, uma vez por sessão, um
   toast a dizer o que há. Um push que não chegue não perde nada. */
async function comentariosAvisos(arranque){
  try{COM_AVISOS=(await sbRpc('comentarios_avisos',{}))||null;}catch(e){COM_AVISOS=null;}
  const a=COM_AVISOS||{}, adm=a.admin||null;
  const meus=Number(a.atencao||0), porTratar=adm?Number(adm.vinho||0)+Number(adm.sugestao||0):0;
  const n=meus+porTratar;
  const el=document.getElementById('cfg-n');
  if(el){el.textContent=n>0?String(n):'';el.classList.toggle('on',n>0);}
  comAdminPintar();
  if(!arranque||!n)return;
  const chave=meus+'/'+porTratar;
  let visto=null;try{visto=sessionStorage.getItem('gf_avisos');}catch(e){}
  if(visto===chave)return;
  try{sessionStorage.setItem('gf_avisos',chave);}catch(e){}
  toast(meus>0
    ?(Number(a.duvidas||0)>0?'📬 O admin tem uma pergunta para ti — vê em ⚙️ › Sugestões e comentários'
                            :'📬 O admin respondeu a um comentário teu — vê em ⚙️ › Sugestões e comentários')
    :`📬 ${porTratar} comentário${porTratar>1?'s':''} ou sugest${porTratar>1?'ões':'ão'} por tratar no WineCatalog`);
}
/* Ao admin do catálogo, no mesmo cartão: o que está por tratar, e o
   caminho para lá (é no WineCatalog que se trata). */
function comAdminPintar(){
  const box=document.getElementById('cfg-com-admin');
  if(!box)return;
  const adm=COM_AVISOS&&COM_AVISOS.admin;
  if(!adm){box.innerHTML='';return;}
  const v=Number(adm.vinho||0), s=Number(adm.sugestao||0);
  box.innerHTML=`<div class="cm-adm"><span>${v+s
      ?`📬 <b>${v}</b> comentário${v===1?'':'s'} e <b>${s}</b> sugest${s===1?'ão':'ões'} por tratar`
      :'📭 Nada por tratar'}</span>
    <a class="mini" href="/WineCatalog/#alertas" target="_blank" rel="noopener">Abrir no WineCatalog ›</a></div>`;
}
/* O toque numa notificação abre a app em "#comentarios" (ver o sw.js):
   vai-se a Definições, ao cartão da conversa. */
function comentariosIrPara(){
  if(location.hash!=='#comentarios')return;
  history.replaceState(null,'',location.pathname+location.search);
  const bts=document.querySelectorAll('.itabs .it');
  tab('cfg',bts[ORDEM_TABS.indexOf('cfg')]);
  setTimeout(()=>{const c=document.getElementById('fcard-comentarios');if(c)c.scrollIntoView({behavior:'smooth',block:'start'});},80);
}
window.addEventListener('hashchange',()=>{if(_sbSession&&GA_LISTA.length)comentariosIrPara();});

/* ── NOTIFICAÇÕES PUSH (migração 27) ──────────────────────────────────
   Ligam-se por APARELHO, aqui em Definições: o browser pede autorização,
   subscreve com a chave pública da Edge Function `garrafeira-push`, e a
   subscrição fica na BD em nome de quem está com sessão
   (`push_registar`). Quem envia é a base — os gatilhos dos comentários
   escrevem uma caixa de saída e acordam a função (db/migracao-push.sql) —,
   por isso nada aqui depende de a app estar aberta. No iPhone só funciona
   com a app no ecrã principal; o cartão di-lo. */
const FN_PUSH=SB_URL+'/functions/v1/garrafeira-push';
const PUSH_ESTADO={enviado:'chegou',sem_subscricao:'não havia aparelho ligado',falhou:'falhou',pendente:'a enviar'};
function pushSuportado(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;}
function pushIOSsemInstalar(){
  const ios=/iP(hone|ad|od)/.test(navigator.userAgent);
  const inst=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone;
  return ios&&!inst;
}
async function pushSubAtual(){
  try{const reg=await navigator.serviceWorker.ready;return await reg.pushManager.getSubscription();}
  catch(e){return null;}
}
function b64UrlBytes(s){
  const b=atob((s+'='.repeat((4-s.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(b,c=>c.charCodeAt(0));
}
async function pushPintar(){
  const box=document.getElementById('cfg-push');
  if(!box)return;
  if(!pushSuportado()){
    box.innerHTML=`<div class="note cm-push-n">🔕 ${pushIOSsemInstalar()
      ?'No iPhone, as notificações só funcionam com a app no ecrã principal: Partilhar › <b>Adicionar ao ecrã principal</b>, e abre-a daí.'
      :'Este browser não recebe notificações.'}</div>`;
    return;
  }
  if(Notification.permission==='denied'){
    box.innerHTML='<div class="note cm-push-n">🔕 As notificações desta app estão bloqueadas — liga-as nas definições do telemóvel (ou do browser).</div>';
    return;
  }
  const sub=await pushSubAtual();
  let est=null;
  if(sub){try{est=await sbRpc('push_estado',{p_endpoint:sub.endpoint});}catch(e){}}
  const para=(COM_AVISOS&&COM_AVISOS.admin)?'quando chegar um comentário ou uma resposta':'quando o admin responder aos teus comentários';
  if(sub&&est&&est.registado){
    const u=est.ultimo;
    box.innerHTML=`<div class="cm-push"><span>🔔 Notificações ligadas neste aparelho</span>
        <button class="mini" onclick="pushDesligar()">Desligar</button></div>
      ${u?`<div class="note">Último aviso: ${esc(u.titulo)} · ${esc(dataHoraLocal(u.quando))} · ${esc(PUSH_ESTADO[u.estado]||u.estado)}</div>`:''}`;
  }else{
    box.innerHTML=`<div class="cm-push"><span>🔕 Recebe um aviso no telemóvel ${esc(para)}</span>
        <button class="mini p" onclick="pushLigar()">🔔 Ligar</button></div>`;
  }
}
async function pushLigar(){
  if(!pushSuportado())return;
  try{
    // O pedido de autorização é a PRIMEIRA coisa depois do toque: o Safari
    // recusa-o fora do gesto de quem carregou.
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){toast('Sem autorização para mostrar notificações',1);pushPintar();return;}
    const r=await sbFetch(FN_PUSH,{method:'POST',headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({acao:'chave'})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.chave)throw new Error(r.status===404?'a função garrafeira-push ainda não está publicada':(d.error||('HTTP '+r.status)));
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64UrlBytes(d.chave)});
    const j=sub.toJSON();
    await sbRpc('push_registar',{p_endpoint:j.endpoint,p_p256dh:j.keys.p256dh,p_auth:j.keys.auth});
    toast('🔔 Notificações ligadas neste aparelho');
  }catch(e){
    toast('Não foi possível ligar as notificações: '+e.message,1);
  }
  pushPintar();
}
async function pushDesligar(){
  const sub=await pushSubAtual();
  if(sub){
    try{await sbRpc('push_retirar',{p_endpoint:sub.endpoint});}catch(e){}
    try{await sub.unsubscribe();}catch(e){}
  }
  toast('Notificações desligadas neste aparelho');
  pushPintar();
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
function linha(rot,val,id,campos){
  if(!val)return '';
  // A marca só aparece quando a comparação já respondeu e o campo consta
  // dos que não batem certo — `catMarca` devolve '' em todos os outros
  // casos, campos incluídos (id/campos são opcionais de propósito).
  const marca=(id&&campos)?catMarca(id,campos):'';
  return `<div class="mdl"><b>${esc(rot)}</b><span>${val}${marca}</span></div>`;
}
/* A capa do vinho: a garrafa (ou a foto do rótulo), o nome e a origem
   sobre o bordô, com a nota do Vivino e a maturação já lá em cima. O
   resto — ficha, onde está, o que se bebeu — fica em papel por baixo,
   com as secções separadas por filete.
   Esta capa é também a BARRA da página: fica colada ao topo e encolhe ao
   rolar (ver "PÁGINA DO VINHO"). Só tem o ✕ — um ‹ à esquerda recuava a
   coluna do nome 40px para repetir o que o ✕ e o arrastar já fazem. */
function vinhoDetalheHTML(v){
  // Um vinho do CATÁLOGO (id negativo) abre nesta mesma página: sai o que é
  // da garrafa e de quem a tem (onde está, as minhas notas, as bebidas,
  // editar, apagar) e entra o "Na tua garrafeira" (`catNaMinhaHTML`).
  const cat=v.id<0;
  const ativas=garrafasDe(v.id,true), bebidas=garrafasDe(v.id,false).filter(g=>g.estado==='consumida');
  const cl=castaLabel(v), jan=janelaBeber(v);
  const estagio=v.estagio_texto||(v.estagio_meses?`${v.estagio_meses} meses`:'');
  const idadeInfo=v.beber_de||v.beber_ate
    ? `${v.beber_de||'?'} – ${v.beber_ate||'?'}  ${janelaBadge(v,jan,true)}` : '';
  const img=imagemDe(v);
  // O produtor em itálico, por baixo do nome: o nome é o que distingue o
  // vinho, o produtor e a cor são campos à parte (fase 4 dos nomes).
  const origem=[v.produtor?`<i class="mhero-p">${esc(v.produtor)}</i>`:'',esc(v.regiao||''),esc(v.sub_regiao||'')].filter(Boolean).join(' · ');

  // Links pequenos, seguidos por vírgula: o Vivino primeiro (se houver),
  // depois os do utilizador, cada um com o seu ✕ para remover colado a
  // seguir ao nome — não em caixas separadas, que ocupavam uma linha cada.
  const linkItens=[];
  if(v.vivino_url)linkItens.push(`<a href="${esc(v.vivino_url)}" target="_blank" rel="noopener">Ver no Vivino</a>`);
  if(TEM_LINKS)(v.links||[]).forEach((l,i)=>{
    linkItens.push(`<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.titulo||l.url)}</a><button class="mlink-x ro-hide" onclick="removerLink(${v.id},${i})" title="Remover">✕</button>`);
  });

  return `<div class="mhero${cat?' mhero-cat':''}">
      <button class="mx" onclick="fecharModal('modal-vinho')">✕</button>
      <div class="mhero-in">
        <button class="mhero-g" onclick="abrirFoto(${v.id})" title="Ver a imagem em grande">
          ${garrafaSVG(v)}${img?`<img src="${esc(img)}" alt="" onload="fotoCarregou(this)" onerror="this.remove()">`:''}
          <span class="mhero-lupa">⤢</span>
        </button>
        <div class="mhero-tx">
          <div class="mhero-k">${cat?esc(['📚 Catálogo',v.estilo,v.classificacao].filter(Boolean).join(' · ')):`${desejado(v)?'⭐ Wishlist · ':''}${esc([v.estilo,v.classificacao].filter(Boolean).join(' · '))||(desejado(v)?'':'&nbsp;')}`}</div>
          <h3>${esc(v.nome)}${v.tipo?` <span class="mhero-cor">${esc(v.tipo)}</span>`:''}</h3>
          <div class="mhero-s"><span class="mhero-o">${origem}${origem&&v.ano?' · ':''}</span>${v.ano?`<b>${v.ano}</b>`:''}</div>
          ${v.ano?`<div class="mhero-ab">${v.ano}</div>`:''}
          ${notaVivinoHeroHTML(v)}
          ${jan?`<span class="mhero-n">${JANELA_TXT[jan]}</span>`:''}
        </div>
      </div>
    </div>

    <div class="vc-badges" style="margin-top:14px">
      ${v.mencao?`<span class="bdg men">${esc(v.mencao)}</span>`:''}
      ${cl?`<span class="bdg mono">${esc(cl)}</span>`:''}
      ${(v.castas||[]).map(c=>`<span class="bdg cas" onclick="filtrarPorCasta('${escJs(c)}')" style="cursor:pointer" title="Ver tudo com esta casta">🍇 ${esc(c)}</span>`).join('')}
    </div>

    ${cat?(catPodeCriar()?`<div class="macoes">
      ${podeUsarIA()?`<button class="btn prim" onclick="iaAbrirProcura(${v.id})">🔎 Procurar informação</button>`:''}
      <button class="btn ${podeUsarIA()?'ghost':'prim'}" onclick="abrirEditarVinho(${v.id})">✏️ Editar</button>
    </div>`:''):`<div class="macoes ro-hide">
      <button class="btn prim" onclick="iaAbrirProcura(${v.id})">🔎 Procurar informação</button>
      <button class="btn ghost" onclick="abrirEditarVinho(${v.id})">✏️ Editar</button>
    </div>
    ${catTiraHTML(v)}`}

    ${cat?catNotasHTML(v)+catNaMinhaHTML(v):desejado(v)?`<div class="msec">Wishlist</div>
    <div class="desejo-faixa">
      <div class="note">${bebidas.length?'⭐ Já foi bebido e quer-se voltar a ter.'
        :`⭐ Ainda não está na garrafeira — é um vinho que se quer ter.${v.criado_em?` Na wishlist desde ${dataPT(String(v.criado_em).slice(0,10))}.`:''}`}</div>
      <div class="macoes ro-hide" style="margin-top:10px">
        <button class="btn prim" onclick="abrirEditarVinho(${v.id},'converter')">🍷 Passar para a garrafeira</button>
        <button class="btn ghost" onclick="retirarDesejo(${v.id})">Retirar da wishlist</button>
      </div>
    </div>`:`<div class="msec">Onde está</div>
    ${ativas.length
      ? ativas.map(g=>{
          const pos=[g.prateleira,g.lugar?'lugar '+g.lugar:'',g.caixa_madeira?'em caixa de madeira':''].filter(Boolean).join(' · ');
          const meta=[g.formato||'',g.preco_compra!=null?'comprada por '+eur(g.preco_compra):'',
                      g.comprado_em?dataPT(g.comprado_em):''].filter(Boolean).join(' · ');
          return `<div class="mgar">
          <div class="g-onde">
            <b>📍 ${esc(nomeLocal(g.local_id))}</b>
            ${pos?`<span class="g-pos">${esc(pos)}</span>`:''}
            ${meta?`<i>${esc(meta)}</i>`:''}
          </div>
          <button class="mini ro-hide" onclick="abrirGarrafa(${g.id})">${temLocaisDesenhados()?'Mover':'Editar'}</button>
          <button class="mini o ro-hide" onclick="abrirConsumir(${v.id},${g.id})">Consumir</button>
        </div>`;}).join('')
      : `<div class="note" style="padding:8px 0">Não há garrafas deste vinho na garrafeira${bebidas.length?' — já foram todas bebidas':''}.</div>`}
    <button class="btn ghost ro-hide" onclick="abrirGarrafa(0,${v.id})">+ Acrescentar garrafa</button>
    ${TEM_DESEJO&&!ativas.length&&bebidas.length?`<button class="btn ghost ro-hide" onclick="quererDeNovo(${v.id})">⭐ Quero voltar a ter</button>`:''}`}

    <div class="msec">Ficha</div>
    <div class="mdet">
      ${linha('Produtor',esc(v.produtor)+(PROD_COMPLETO[v.produtor]?`<small class="mdl-sub">${esc(PROD_COMPLETO[v.produtor])}</small>`:''))}
      ${linha('Ano',v.ano||'')}
      ${linha('Tipo',esc([v.tipo,v.estilo].filter(Boolean).join(' · ')),v.id,['tipo','estilo'])}
      ${linha('Região',esc([v.regiao,v.sub_regiao].filter(Boolean).join(' · ')),v.id,['regiao','sub_regiao'])}
      ${linha('Classificação',esc(v.classificacao),v.id,'classificacao')}
      ${linha('Castas',(v.castas||[]).length?esc(v.castas.join(', ')):'',v.id,'castas')}
      ${linha('Estágio',esc(estagio),v.id,['estagio_meses','estagio_texto'])}
      ${linha('Álcool',v.teor?esc(v.teor)+'%':'',v.id,'teor')}
      ${(()=>{const p=precoPrincipal(v);return p&&p.loja
        ?linha('Preço',esc(eur(p.preco))+` <span class="mp-de">· ${esc(precoFonteTxt(p))}</span>`):'';})()}
      ${linha('Preço de referência',v.preco_medio!=null?eur(v.preco_medio):'',v.id,'preco_medio')}
      ${linha('Beber entre',idadeInfo,v.id,['beber_de','beber_ate'])}
      ${linha('Notas de prova',esc(v.notas_prova),v.id,'notas_prova')}
      ${linha('Harmoniza com',esc(v.harmonizacao),v.id,'harmonizacao')}
      ${linha('As minhas notas',esc(v.notas))}
    </div>

    ${precosLojaHTML(v)}

    ${v.ai_resumo?`<div class="msec">O que se sabe</div>
      <div class="note" style="margin-top:8px;font-size:12.5px">${esc(v.ai_resumo)}</div>`:''}
    ${Array.isArray(v.ai_fontes)&&v.ai_fontes.length?`<div class="ia-fontes">
      Fontes: ${v.ai_fontes.map(f=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}
    </div>`:''}

    ${cat?(v.vivino_url?`<div class="msec">Links</div><div class="mlinks">${linkItens.join(', ')}</div>`:'')
    :(TEM_LINKS||v.vivino_url)?`<div class="msec">Links</div>
      ${linkItens.length
        ? `<div class="mlinks">${linkItens.join(', ')}</div>`
        : '<div class="note" style="padding:8px 0">Sem links guardados.</div>'}
      ${TEM_LINKS?`<button class="btn ghost ro-hide" onclick="adicionarLink(${v.id})">+ Acrescentar link</button>`:''}`:''}

    ${bebidas.length?`<div class="msec">Já bebidas (${bebidas.length})</div>
      ${bebidas.sort((a,b)=>String(b.consumido_em).localeCompare(String(a.consumido_em))).map(g=>`
        <div class="mgar"><div class="g-onde"><b>${dataPT(g.consumido_em)}${g.consumo_local?' · '+esc(g.consumo_local):''}</b>
          <i>${g.consumo_avaliacao?estrelas(g.consumo_avaliacao)+' '+avalFmt(g.consumo_avaliacao)+' ':''}${(g.notas||[]).map(n=>esc(n.nota)).join(' · ')}</i></div></div>`).join('')}`:''}

    ${cat?`<div class="msec">Atualizações</div>
    <div class="ia-fontes">Última alteração no catálogo: ${dataHoraLocal(v.atualizado_em||v.criado_em)}</div>
    <div class="macoes"><button class="btn ghost" onclick="fecharModal('modal-vinho')">Fechar</button></div>`:`
    <div class="msec">Atualizações</div>
    <div class="ia-fontes">
      Pesquisa com IA: ${v.ai_atualizado_em&&/^gemini/i.test(String(v.ai_modelo||''))
        ?dataHoraLocal(v.ai_atualizado_em):'ainda não'}<br>
      Atualização manual: ${dataHoraLocal(TEM_ATUALIZADO?(v.atualizado_em||v.criado_em):v.criado_em)}
    </div>
    <div class="cat-tira cm-tira" onclick="abrirComentario(${v.id})">
      <span class="cat-tira-i">💬</span>
      <span><strong>Algo não está bem?</strong> Um atributo errado, ou um site com a informação certa — diz ao admin do catálogo.</span>
      <span class="cat-tira-v">escrever</span>
    </div>

    <div class="macoes">
      <button class="btn ghost" onclick="fecharModal('modal-vinho')">Fechar</button>
      ${desejado(v)?'':`<button class="btn danger ro-hide" onclick="apagarVinho(${v.id})">🗑 Apagar vinho</button>`}
    </div>`}`;
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
      ${img?`<img src="${esc(img)}" alt="" onload="this.parentNode.classList.add('com-foto')" onerror="this.remove()">`:''}
    </div>

    <div class="note" id="foto-estado"></div>

    ${vinhoId<0?'':`<div class="macoes ro-hide">
      <label class="btn prim" style="text-align:center;cursor:pointer;margin:0">
        📷 ${minha?'Trocar a imagem':'Carregar uma imagem'}
        <input type="file" accept="image/*" style="display:none" onchange="enviarFoto(this)">
      </label>
      ${minha?`<button class="btn danger" onclick="apagarFotoPropria()">Remover a minha</button>`:''}
    </div>
    <div class="note" style="margin-top:10px">${minha
      ? 'Se removeres a tua, volta a aparecer a imagem que a procura encontrou (ou a garrafa desenhada).'
      : 'A tua imagem fica guardada na garrafeira e passa a ser a que aparece em todo o lado.'}</div>`}`;
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
  F.casta=[nome];
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

/* ── WISHLIST ──────────────────────────────────────────────────────
   Os vinhos que não estão cá mas que se querem ter (migração 15). Não é
   uma tabela à parte: é um vinho como os outros, sem garrafas e com
   `desejado` ligado — por isso a ficha, a procura da IA, a página do vinho
   e o Editar são os de sempre, e passar um desejo para a garrafeira é
   desligar a marca e acrescentar garrafas (`abrirEditarVinho(id,'converter')`),
   sem copiar a ficha de um lado para o outro.
   Não aparece em Detalhe/Locais/Resumo sem ninguém ter de o esconder: esses
   só contam vinhos com garrafas (`stockDe>0`), e um desejo não tem nenhuma.
   É visível também numa garrafeira EMPRESTADA — é o sítio onde um amigo vai
   ver o que oferecer — mas só o dono lhe mexe (`ro-hide`/`roGuard`). */
function desejos(){
  return db.vinhos.filter(desejado).sort((a,b)=>
    String(a.nome||'').localeCompare(String(b.nome||''),'pt',{numeric:true,sensitivity:'base'})||
    String(a.ano||'').localeCompare(String(b.ano||''),'pt',{numeric:true}));
}
function renderDesejos(){
  const box=document.getElementById('desejos');
  if(!box)return;
  const ds=desejos();
  document.getElementById('desejos-count').textContent=`${ds.length} vinho${ds.length===1?'':'s'}`;
  const pdf=document.getElementById('desejos-pdf');
  if(pdf)pdf.disabled=!ds.length;
  box.innerHTML=ds.length
    ? ds.map(v=>vinhoCardHTML(v,[],false)).join('')
    : `<div class="vazio"><b>A wishlist está vazia</b>Os vinhos que ainda não tens mas queres ter.${isReadOnly?'':' Toca em <b>+ Adicionar</b> — a procura preenche a ficha, como num vinho novo.'}</div>`;
}
function novoDesejo(){
  if(!TEM_DESEJO||roGuard())return;
  abrirEditarVinho(0,'desejo');
}
// Retirar um desejo é apagá-lo: não tem garrafas nem histórico de consumo,
// é só a ficha — e o que ela tinha de sabido já foi para o catálogo pela
// procura da IA. `semPerguntar` é para quem já perguntou (o
// `oferecerRetirarDesejos`, a seguir a um vinho novo).
// A EXCEÇÃO é o vinho já bebido que se quer voltar a ter (`quererDeNovo`):
// tem garrafas consumidas, e apagá-lo levava-as atrás (CASCADE) — a prova,
// a nota, os comentários. Esse só perde a marca.
async function retirarDesejo(id,semPerguntar){
  if(roGuard())return false;
  const v=IDXV[id];if(!v||!desejado(v))return false;
  if(!semPerguntar&&!confirm(`Retirar "${v.nome}" da wishlist?`))return false;
  if(garrafasDe(id,false).length){
    try{
      await sbReq('PATCH',`vinhos?id=eq.${id}`,{desejado:false});
      v.desejado=false;
      renderLista();refrescarVinhoAberto();
      toast('Retirado da wishlist');
      return true;
    }catch(e){toast('Não foi possível retirar: '+e.message,1);return false;}
  }
  try{
    const foto=String(v.imagem_path||'').trim();
    await sbReq('DELETE',`vinhos?id=eq.${id}`);
    if(foto)apagarObjeto(foto);
    db.vinhos=db.vinhos.filter(x=>x.id!==id);
    reindexar();
    if(VINHO_ABERTO===id)fecharModal('modal-vinho');
    renderLista();
    toast('Retirado da wishlist');
    return true;
  }catch(e){toast('Não foi possível retirar: '+e.message,1);return false;}
}
// "Bebi, gostei, quero voltar a ter": um vinho já todo bebido passa para a
// wishlist com a MESMA ficha, e a prova fica onde estava. Sem isto a única
// saída era um "Novo vinho na wishlist" — duas fichas do mesmo vinho na mesma
// garrafeira, e ao voltar a comprá-lo as garrafas novas longe da prova.
async function quererDeNovo(id){
  if(!TEM_DESEJO||roGuard())return;
  const v=IDXV[id];if(!v||desejado(v)||stockDe(id))return;
  try{
    await sbReq('PATCH',`vinhos?id=eq.${id}`,{desejado:true});
    v.desejado=true;
    renderLista();refrescarVinhoAberto();
    toast('Na wishlist ⭐');
  }catch(e){toast('Não foi possível pôr na wishlist: '+e.message,1);}
}

/* "Este vinho novo é um da wishlist?" — para quem comprou um desejo e o pôs
   pelo "Novo vinho" (ou pela importação) em vez de o passar a partir da
   wishlist. É uma SUGESTÃO, e a pessoa confirma par a par: a semelhança
   serve para propor, nunca para decidir (a lição dos Duplicados da
   WineCatalog). Por isso a regra é apertada:
   - as palavras do NOME de cada um têm de estar todas no nome+produtor do
     outro — é o que deixa "Touriga Nacional" (produtor Quinta do Vallado)
     casar com "Quinta do Vallado Touriga Nacional", e o que impede "Quinta
     do Crasto" de casar com "Quinta do Crasto Reserva" (sobra o "reserva");
   - com o produtor escrito dos dois lados, têm de partilhar uma palavra —
     senão o Touriga Nacional do Esporão casava com o do Vallado;
   - com a cor escrita dos dois lados, tem de ser a mesma.
   O ANO não entra: quer-se "o Barca Velha" e compra-se o de 2011. */
const DESEJO_VAZIAS=new Set(['de','do','da','dos','das','e','d','the','o','a']);
function palavrasDesejo(s){
  return chave(s).replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(t=>t&&!DESEJO_VAZIAS.has(t));
}
function mesmoDesejo(a,b){
  const na=palavrasDesejo(a.nome), nb=palavrasDesejo(b.nome);
  if(!na.length||!nb.length)return false;
  const pa=palavrasDesejo(a.produtor), pb=palavrasDesejo(b.produtor);
  const ta=new Set(na.concat(pa)), tb=new Set(nb.concat(pb));
  if(!na.every(t=>tb.has(t))||!nb.every(t=>ta.has(t)))return false;
  if(pa.length&&pb.length&&!pa.some(t=>pb.includes(t)))return false;
  if(a.tipo&&b.tipo&&a.tipo!==b.tipo)return false;
  return true;
}
async function oferecerRetirarDesejos(novos){
  if(!TEM_DESEJO||isReadOnly)return;
  const vistos=new Set();
  for(const v of (novos||[]).filter(Boolean)){
    for(const d of desejos()){
      if(d.id===v.id||vistos.has(d.id)||!mesmoDesejo(v,d))continue;
      vistos.add(d.id);
      const nomeD=`${d.nome}${d.ano?' '+d.ano:''}${d.produtor?' ('+d.produtor+')':''}`;
      if(confirm(`⭐ "${nomeD}" estava na tua wishlist.\n\n`+
                 `Acabaste de pôr "${v.nome}${v.ano?' '+v.ano:''}" na garrafeira — é o mesmo vinho? `+
                 `Se for, retira-se da wishlist.`))
        await retirarDesejo(d.id,true);
    }
  }
}

/* A wishlist em PDF, para mandar a quem nos queira oferecer um vinho. A
   mesma folha do "Exportar PDF" (`pdfPreAbrir`, ver lá porquê o iframe),
   com as colunas que servem a quem vai à LOJA: o que é, de quem, de onde,
   quanto custa mais ou menos e onde o ver. Nada do que é da casa — as
   minhas notas ficam de fora (são minhas, e o PDF é para enviar). */
function exportarWishlistPDF(){
  const ds=desejos();
  if(!ds.length){toast('A wishlist está vazia',1);return;}
  const cols=['Vinho','Ano','Produtor','Tipo','Região','Castas','Menção','Preço','Vivino'];
  const linhas=ds.map(v=>`<tr>
      <td class="pnome">${esc(v.nome)}</td>
      <td class="pc">${v.ano||''}</td>
      <td>${esc(v.produtor)}</td>
      <td>${esc([v.tipo,v.estilo].filter(Boolean).join(' · '))}</td>
      <td>${esc([v.regiao,v.sub_regiao].filter(Boolean).join(' · '))}</td>
      <td>${esc((v.castas||[]).join(', '))}</td>
      <td>${esc([v.mencao,v.classificacao].filter(Boolean).join(' · '))}</td>
      <td class="pc">${precoPDF(v)}</td>
      <td class="pc">${vivinoPDF(v)}${v.vivino_url
        ?`${notaVivino(v)?' · ':''}<a href="${esc(v.vivino_url)}">ver</a>`:''}</td>
    </tr>`).join('');
  const sub=[nomeGarrafeira(),`${ds.length} vinho${ds.length===1?'':'s'} que gostava de ter`].filter(Boolean).join(' · ');
  pdfPreAbrir(`
    <div class="pcab">
      <div><h1>Wishlist de vinhos</h1><div class="psub">${esc(sub)}</div></div>
      <div class="pdata">${esc(dataPT(hoje()))}</div>
    </div>
    <div class="pwrap">
      <table>
        <thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`,'Wishlist');
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
  const chaveAtual=chaveLugarLayout(document.getElementById(`${prefix}-lugar`).value);
  // Com a numeração corrida a prateleira sai do número, e escrevê-la à mão
  // noutro campo só dava para os dois se contradizerem: aqui ela deixa de
  // se editar e passa a mostrar o que o lugar diz.
  const pratBox=document.getElementById(`${prefix}-pratbox`);
  const pratIn=document.getElementById(`${prefix}-prat`);
  if(pratIn){
    pratIn.readOnly=true;
    pratIn.value=nomeDaPosicao(localId,chaveAtual)||'';
    pratIn.placeholder='(pelo lugar)';
  }
  if(pratBox)pratBox.classList.add('derivado');
  const lbl=document.getElementById(`${prefix}-lugarlbl`);
  // com encostos e topo o lugar já não é só "1 a N": há códigos (15D, T2)
  if(lbl)lbl.textContent=especiaisLocal(l).length?'Lugar (nº, 15D ou T2)':`Lugar (1 a ${lugaresCorridosLocal(l)})`;
  const livres=prats.reduce((s,p)=>{
    let n=0;
    for(let i=1;i<=p.capacidade;i++)if(!(occ[String(p.base+i)]||[]).length)n++;
    return s+n;
  },0)+especiaisLocal(l).filter(x=>!(occ[x.codigo]||[]).length).length;
  const topoPick=prateleiraTopo(l);
  box.innerHTML=`
    <div class="lpick">
      <div class="lpick-top">
        <div>
          <div class="msec">Posição no desenho</div>
          <div class="note">Escolhe um lugar livre na estante. Se ainda não souberes onde fica, deixa em branco e a garrafa aparece por posicionar.</div>
        </div>
        <div class="lpick-n">${livres} ${livres===1?'livre':'livres'}</div>
      </div>
      ${(topoPick?[topoPick]:[]).concat(prateleirasDesc(prats)).map(p=>`
        ${(()=>{const pp=Object.assign({},p,{ondulada:false,desvio:0});const info=prateleiraLayoutInfo(pp);const compacto=p.formato!=='fila';return `<div class="lprat">
          <div class="lprat-t">${esc(p.nome)} <span>${p.topo?(p.capacidade===1?'lugar T1':`lugares T1–T${p.capacidade}`)
            :(p.capacidade===1?`lugar ${p.base+1}`:`lugares ${p.base+1}–${p.base+p.capacidade}`)}${
            p.encosto_dir||p.encosto_esq?` · encosto ${[p.encosto_esq?p.cod_esq:'',p.encosto_dir?p.cod_dir:''].filter(Boolean).join(' e ')}`:''}</span></div>
          ${estanteHTML(pp,info,info.slots.map(s=>{
            const k=String(s.lugar);
            const pos=` style="${slotGridStyle(s)}"`;
            const lista=occ[k]||[];
            const sel=chaveAtual===k;
            if(lista.length){
              const v=IDXV[(lista[0]||{}).vinho_id]||{nome:'?'};
              return `<button type="button" class="lpslot${compacto?' mini':''} ocup" disabled${pos} title="${esc(v.nome)} · ${esc(posicaoTxt(p.nome,k))}">${garrafaSVG(v,1)}<span>${esc(k)}</span></button>`;
            }
            return `<button type="button" class="lpslot${compacto?' mini':''}${sel?' on':''}"${pos} onclick="escolherPosicaoLayout('${prefix}','${escJs(k)}')" title="${esc(posicaoTxt(p.nome,k))}"><span>${esc(k)}</span></button>`;
          }).join(''),'est-pick'+(p.topo?' est-topo':''))}
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

/* ── FAB — "Novo vinho", "Atualização massiva" e "Importar por imagens" ──
   Mesmo desenho da WineCatalog: um "+" flutuante que abre duas ações, em
   vez de um botão só. O FAB do Garrafeira já vive a z-index 90, ABAIXO
   dos modais (200) — ao contrário da WineCatalog não há aqui o bug do FAB
   a roubar o toque ao modal, e por isso não precisa da mesma trava; ainda
   assim `abrirModal` fecha o menu do FAB, para não ficar um menu aberto
   por trás de um modal que se abriu por cima.
   A "Importar por imagens" esteve em Definições › Dados e veio para aqui:
   é uma forma de ACRESCENTAR vinhos, como as outras duas, e estava
   arrumada no cartão das cópias de segurança — que é por onde os dados
   SAEM. Quem acabou de fotografar a prateleira procura o "+", não as
   definições. O guarda continua a ser o da própria `importarAbrir()`
   (`podeUsarIA()`), como no `loteAbrir()`: em `sem_ia` a opção aparece e
   diz porque é que não dá, em vez de desaparecer sem explicação. */
function fabToggle(){
  if(modoCat()){catNovoVinho();return;}
  if(tabAtiva==='desejos'){novoDesejo();return;}
  const w=document.getElementById('fab-wrap');
  if(w)w.classList.toggle('open');
}
function fabFechar(){
  const w=document.getElementById('fab-wrap');
  if(w)w.classList.remove('open');
}
function fabAcao(tipo){
  fabFechar();
  if(tipo==='novo')abrirNovoVinho();
  if(tipo==='lote')loteAbrir();
  if(tipo==='importar')importarAbrir();
  if(tipo==='desejo')novoDesejo();
}

function abrirNovoVinho(){
  if(roGuard())return;
  abrirEditarVinho(0);
}
/* `modo` (a WISHLIST, migração 15) — o MESMO formulário serve três portas
   a mais, em vez de três formulários parecidos a divergirem:
   - 'desejo' (id=0): um vinho novo para a wishlist. Igual ao "Novo vinho",
     com a procura da IA e tudo, mas sem "Primeira garrafa" — ainda não há
     garrafa nenhuma;
   - 'converter' (id de um desejo): passá-lo para a garrafeira. A ficha
     que já lá está, editável (o ano, o preço…), MAIS a "Primeira garrafa"
     (onde fica, quantas, o preço de compra). Gravar desliga a marca e
     cria as garrafas — a ficha não se copia para lado nenhum. */
function abrirEditarVinho(id,modo){
  // 'catalogo' (os curadores, migração 32): um vinho novo NO CATÁLOGO, sem
  // garrafa nem notas minhas — a garrafeira aberta não conta para nada.
  const noCat=!id&&modo==='catalogo';
  // Um vinho DO catálogo (id negativo): corrige-se a linha para toda a gente
  // (`catGuardarEditar`), e só quem o admin fez curador.
  const catEd=id<0;
  if((noCat||catEd)?!catPodeCriar():roGuard())return;
  FORM_CAT=noCat;FORM_MODO=modo||'';
  const v=id?IDXV[id]:null;
  if(id&&!v)return;
  const conv=!!id&&modo==='converter';
  const paraDesejo=!id&&modo==='desejo';
  const comGarrafa=((!id&&!paraDesejo)||conv)&&!noCat;
  const titulo=noCat?'Novo vinho no catálogo':catEd?'Corrigir no catálogo':conv?'Passar para a garrafeira':id?'Editar vinho':paraDesejo?'Novo vinho na wishlist':'Novo vinho';
  const rotulo=noCat?'Criar no catálogo':catEd?'Guardar no catálogo':conv?'Passar para a garrafeira':id?'Guardar':paraDesejo?'Adicionar à wishlist':'Adicionar à garrafeira';
  _catBaseNovo=null;
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
    <div class="mtop"><h3>${titulo}</h3>
      <button class="mx" onclick="fecharModal('modal-edit')">✕</button></div>

    <label>Nome</label>
    <input type="text" id="e-nome" value="${esc(o('nome'))}" placeholder="Quinta do Vallado Touriga Nacional">
    <div class="mrow">
      <div><label>Ano</label><input type="number" id="e-ano" inputmode="numeric" value="${esc(o('ano'))}" placeholder="${paraDesejo?'opcional':'2021'}" oninput="janelaSincronizarForm()"></div>
      <div>${id
        ?`<label>Produtor</label><input type="text" id="e-produtor" value="${esc(o('produtor'))}" placeholder="Quinta do Vallado">`
        // A cor tem de vir de quem procura: fica em cima,
        // no formulário compacto, com o que só a PESSOA sabe.
        :'<label>Cor</label><select id="e-tipo"><option value="">— escolhe a cor —</option>'+opts(TIPOS,o('tipo',''))+'</select>'
      }</div>
    </div>
    ${id?'':`<label>Produtor <span style="text-transform:none;font-weight:400">— opcional, ajuda a acertar</span></label>
      <input type="text" id="e-produtor" value="${esc(o('produtor'))}" placeholder="Quinta do Vallado">`}

    ${conv?`<div class="aviso">Revê a ficha (o ano, sobretudo — o que se quer e o que se comprou nem sempre são a mesma colheita) e diz onde fica a garrafa. Sai da wishlist e entra na garrafeira.</div>`:''}
    ${id&&!conv&&!catEd?`<div class="mrow">
      <div><label>Formato da garrafa</label><select id="e-formato-edit">${FORMATOS.map(x=>
        `<option value="${esc(x)}"${formatoAtual===x?' selected':''}>${esc(x)}</option>`).join('')}</select></div>
    </div>
    <div class="note">Aplica-se a todas as garrafas deste vinho ainda na garrafeira.</div>`:''}

    ${id?'':`<div class="macoes" id="e-botoes">
        <button class="btn prim" onclick="pqAbrirNovo()">🔎 Procurar informação</button>
        <button class="btn ghost" onclick="${noCat?'pqAbrirNovo(true)':'formMostrarResto()'}">✏️ Preencher à mão</button>
      </div>`}
    <div id="e-ia-estado"></div>

    <div id="e-resto"${id?'':' style="display:none"'}>
    <button class="pq-link" style="margin-top:10px" onclick="formManualAbrir()">✍️ Gerar um prompt para outro assistente (ChatGPT, Claude…) e colar a resposta</button>
    <div class="mrow">
      ${id?`<div><label>Tipo</label><select id="e-tipo">${opts(TIPOS,o('tipo','Tinto'))}</select></div>`:''}
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

    <div class="note" id="e-jan-nota" style="display:none">Sem ano não há <b>janela de consumo</b>:
      os anos dela seriam os de uma colheita qualquer.</div>
    <div class="mrow" id="e-jan">
      <div><label>Beber a partir de</label><input type="number" id="e-beber-de" inputmode="numeric" value="${esc(o('beber_de'))}" placeholder="2026"></div>
      <div><label>Beber até</label><input type="number" id="e-beber-ate" inputmode="numeric" value="${esc(o('beber_ate'))}" placeholder="2034"></div>
    </div>
    <div class="mrow">
      <div><label>Preço de referência (€)</label><input type="text" id="e-preco" inputmode="decimal" value="${esc(o('preco_medio'))}" placeholder="18.50"></div>
      <div><label>País</label><input type="text" id="e-pais" value="${esc(o('pais',noCat?'':'Portugal'))}" placeholder="Portugal"></div>
    </div>
    <div class="mrow">
      <div><label>Nota Vivino (colheita)</label><input type="text" id="e-vivino" inputmode="decimal" value="${esc(o('vivino_nota'))}" placeholder="4.1"></div>
      <div><label>Avaliações (colheita)</label><input type="number" id="e-vivino-av" inputmode="numeric" value="${esc(o('vivino_avaliacoes'))}" placeholder="250"></div>
    </div>
    <div class="mrow">
      <div><label>Nota Vivino (todas as colheitas)</label><input type="text" id="e-vivino-g" inputmode="decimal" value="${esc(o('vivino_nota_global'))}" placeholder="4.0"></div>
      <div><label>Avaliações (todas)</label><input type="number" id="e-vivino-av-g" inputmode="numeric" value="${esc(o('vivino_avaliacoes_global'))}" placeholder="5000"></div>
    </div>
    <label>Link do Vivino</label>
    <input type="url" id="e-vivino-url" value="${esc(o('vivino_url'))}" placeholder="https://www.vivino.com/…">

    ${TEM_IMAGEM?`<label>Imagem do rótulo <span style="text-transform:none;font-weight:400">— link (opcional)</span></label>
    <input type="url" id="e-imagem" value="${esc(o('imagem_url'))}" placeholder="https://…/rotulo.jpg">
    <div class="note">O link da fotografia, não o da página da loja — e sem nenhum, a app desenha a garrafa com a cor do tipo e o ano no rótulo.</div>`:''}

    <label>Resumo</label>
    <textarea id="e-resumo" placeholder="O que é este vinho, em duas ou três frases">${esc(o('ai_resumo'))}</textarea>
    <label>Notas de prova</label>
    <textarea id="e-notas-prova" placeholder="Aroma, boca, final…">${esc(o('notas_prova'))}</textarea>
    <label>Harmoniza com</label>
    <textarea id="e-harmonizacao" placeholder="Queijos curados, carnes grelhadas…">${esc(o('harmonizacao'))}</textarea>

    ${noCat||catEd?'':`<label>As minhas notas</label>
    <textarea id="e-notas" placeholder="Onde comprei, para que ocasião guardei, o que achei…">${esc(o('notas'))}</textarea>`}

    ${!comGarrafa?'':`
      <div class="msec">${conv&&garrafasDe(id,false).length?'Nova garrafa':'Primeira garrafa'}</div>
      <div class="mrow">
        <div${temLocaisDesenhados()?'':' style="display:none"'}><label>Local</label><select id="e-local">${temLocaisDesenhados()?'':'<option value="" selected></option>'}${locOpts||'<option value="">(cria um local primeiro)</option>'}</select></div>
        <div><label>Quantas</label><input type="number" id="e-qtd" inputmode="numeric" value="1" min="1" max="60"></div>
      </div>
      <div id="e-slotpick"${temLocaisDesenhados()?'':' style="display:none"'}></div>
      <div class="mrow"${temLocaisDesenhados()?'':' style="display:none"'}>
        <div><label>Prateleira</label><input type="text" id="e-prat" placeholder="Nível 3" oninput="renderPickerPosicoes('e',0)"></div>
        <div><label>Lugar</label><input type="text" id="e-lugar" placeholder="12" oninput="renderPickerPosicoes('e',0)"></div>
      </div>
      <div class="mrow">
        <div><label>Formato</label><select id="e-formato">${FORMATOS.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></div>
        <div><label>Preço de compra (€)</label><input type="text" id="e-preco-compra" inputmode="decimal" placeholder="15.90"></div>
      </div>
      <label>Comprada em</label>
      <input type="date" id="e-comprado">`}
    ${noCat?'<div class="note" style="margin-top:10px">Fica no <b>Catálogo</b>, à vista de toda a gente, com a força de uma correção à mão. Não entra na tua garrafeira.</div>':''}
    ${catEd?'<div class="note" style="margin-top:10px">Corrige o vinho no <b>Catálogo</b>, para toda a gente. Um campo que esvazies deixa de lá estar; o nome e o produtor chegam também às garrafeiras que o têm.</div>':''}
    ${paraDesejo?'<div class="note" style="margin-top:10px">Fica na <b>Wishlist</b>, sem garrafas. Quando o comprares (ou to oferecerem), passa-o para a garrafeira na página do vinho.</div>':''}

    <div class="macoes">
      <button class="btn prim" id="e-guardar" onclick="guardarVinho(${id},'${modo||''}')">${rotulo}</button>
      <button class="btn ghost" onclick="fecharModal('modal-edit')">Cancelar</button>
    </div>
    </div>`;
  abrirModal('modal-edit');
  janelaSincronizarForm();
  if(comGarrafa){
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
    // Sem ano, a janela não se grava (a BD também a recusa: trigger
    // `vinhos_sem_colheita`).
    beber_de:inteiro(g('e-ano'))==null?null:inteiro(g('e-beber-de')),
    beber_ate:inteiro(g('e-ano'))==null?null:inteiro(g('e-beber-ate')),
    preco_medio:num(g('e-preco')),
    vivino_nota:num(g('e-vivino')),
    vivino_nota_global:num(g('e-vivino-g')),
    vivino_avaliacoes:inteiro(g('e-vivino-av')),
    vivino_avaliacoes_global:inteiro(g('e-vivino-av-g')),
    vivino_url:g('e-vivino-url'),
    pais:g('e-pais'),
    ai_resumo:g('e-resumo'),
    notas_prova:g('e-notas-prova'),
    harmonizacao:g('e-harmonizacao'),
    notas:g('e-notas'),
    _castas:g('e-castas').split(',').map(s=>s.trim()).filter(Boolean)
  };
  // Só entra no PATCH/POST se a coluna existir na BD (ver detetarImagem).
  if(TEM_IMAGEM)f.imagem_url=g('e-imagem');
  return f;
}

async function guardarVinho(id,modo){
  if(!id&&modo==='catalogo')return catGuardarNovo();
  if(id<0)return catGuardarEditar(id);
  if(roGuard())return;
  const conv=!!id&&modo==='converter';
  const paraDesejo=!id&&modo==='desejo'&&TEM_DESEJO;
  const comGarrafa=(!id&&!paraDesejo)||conv;
  const rotulo=conv?'Passar para a garrafeira':id?'Guardar':paraDesejo?'Adicionar à wishlist':'Adicionar à garrafeira';
  const f=lerFormVinho();
  if(!f.nome){toast('Falta o nome do vinho',1);return;}
  // A cor é parte da identidade do vinho (a chave do catálogo, fase 4 dos
  // nomes): um vinho novo não se grava com o 'Tinto' de omissão.
  const elCor=document.getElementById('e-tipo');
  if(elCor&&!elCor.value){toast('Escolhe a cor do vinho',1);elCor.focus();return;}
  if(!id&&!GA_ID){toast('Não há nenhuma garrafeira aberta',1);return;}
  if(f.ano!=null&&(f.ano<1900||f.ano>2100)){toast('Ano fora do razoável',1);return;}
  let primeiraGarrafa=null;
  if(comGarrafa){
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
  // O carimbo da procura (modelo, fontes, quando) não é um campo do
  // formulário: a procura da IA deixou-o em `_iaExtraNovo` e é aqui que se
  // junta. Só na CRIAÇÃO — a editar, quem manda é o painel de confirmação.
  // Num vinho já gravado (a resposta colada no Editar) só entram onde ele
  // não tinha nada: as notas de prova de alguém não se tapam daqui.
  if(_iaExtraNovo){
    const vAnt=id?IDXV[id]:null;
    Object.entries(_iaExtraNovo).forEach(([k,x])=>{
      if(!id)f[k]=x;
      else if(x!=null&&x!==''&&(vAnt?vAnt[k]==null||vAnt[k]==='':true))f[k]=x;
    });
  }
  // Carimbo da gravação à mão — separado do carimbo da IA (`ai_atualizado_em`),
  // que só muda ao aceitar-se uma pesquisa. Só entra se a coluna existir
  // (ver `detetarAtualizado`).
  if(TEM_ATUALIZADO)f.atualizado_em=new Date().toISOString();
  // A wishlist é só esta marca: ligada ao nascer um desejo, desligada ao
  // passá-lo para a garrafeira (as garrafas vêm logo a seguir, mais abaixo).
  if(paraDesejo)f.desejado=true;
  if(conv&&TEM_DESEJO)f.desejado=false;

  const btn=document.getElementById('e-guardar');
  btn.disabled=true;btn.textContent='A guardar…';
  // Nome e produtor são a chave dos preços das lojas (`recarregarPrecosLoja`).
  const outraChave=!id||f.nome!==IDXV[id].nome||f.produtor!==(IDXV[id].produtor||'');
  try{
    let vinhoId=id;
    if(id){
      // A BD arruma o nome e o produtor (trigger `vinhos_nomes`: nada de
      // CAPS LOCK, "do/da/de" pequenos) e a região — no ecrã fica o que ela
      // gravou, não o que se escreveu.
      const r=await sbReq('PATCH',`vinhos?id=eq.${id}`,f,{'Prefer':'return=representation'});
      Object.assign(IDXV[id],f,(r&&r[0])||{});
      const feEl=document.getElementById('e-formato-edit');   // não existe ao passar um desejo
      const novoFormato=feEl?feEl.value:'';
      const ativas=feEl?garrafasDe(id,true).filter(g=>g.formato!==novoFormato):[];
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

    if(comGarrafa){
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
    if(outraChave)recarregarPrecosLoja();
    if(tabAtiva==='locais')renderMapa();
    toast(conv?'Na garrafeira ✓':id?'Guardado ✓':paraDesejo?'Na wishlist ⭐':'Vinho adicionado ✓');
    if(id&&EU.curador)curadorAviso(vinhoId);
    else if(!id&&EU.curador&&_catBaseNovo)curadorNovo(vinhoId,_catBaseNovo);
    _catBaseNovo=null;
    // Quem comprou um vinho da wishlist e o pôs pelo "Novo vinho" (em vez
    // de o passar a partir da wishlist) fica com o desejo lá esquecido.
    if(!id&&!paraDesejo)await oferecerRetirarDesejos([IDXV[vinhoId]]);
    return vinhoId;
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    btn.disabled=false;btn.textContent=rotulo;
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
          ?`<img src="${esc(imagemDe(v))}" alt="" onload="fotoCarregou(this)" onerror="this.remove()">`:''}</div>
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
    ${avalHTML(null)}

    <label>Observações</label>
    <textarea id="c-nota" placeholder="Estava no ponto, ainda aguentava mais uns anos…"></textarea>

    <div class="macoes">
      <button class="btn prim" id="c-btn" onclick="confirmarConsumo(${vinhoId})">Dar saída</button>
      <button class="btn ghost" onclick="fecharModal('modal-consumir')">Cancelar</button>
    </div>`;
  abrirModal('modal-consumir');
  avalPintar();
}
/* A NOTA VAI DE 1 A 5 COM UMA CASA DECIMAL (4,2 — migração 25). As
   estrelas continuam a ser o gesto rápido: um toque dá o número redondo, e
   outra vez na mesma tira-o. A casa decimal escreve-se na caixa ao lado,
   que é o `c-aval` — o que se grava é SEMPRE o que lá está, por isso as
   estrelas nunca discordam dele: são só o desenho do número (a estrela a
   meio enche-se na proporção, `.star.parte`).
   Antes de haver estrelas isto era um <select> com "★★★☆☆" nas opções —
   dava uma lista de texto no telemóvel e ninguém percebia que era a nota. */
const AVAL_TXT=['','Fraquinho','Assim-assim','Bom','Muito bom','Do outro mundo'];
const AVAL_VAZIO='Sem nota — toca numa estrela (outra vez na mesma para tirar) ou escreve-a ao lado, como 4,2.';
// '' → null (sem nota); fora de 1–5 ou ilegível → NaN, que a gravação recusa.
function avalLer(s){
  if(String(s??'').trim()==='')return null;
  const n=num(s);
  if(n==null||n<1||n>5)return NaN;
  return Math.round(n*10)/10;
}
// Com ponto, como a nota do Vivino ao lado ("★ 4.2").
function avalFmt(n){return Number(n).toFixed(1);}
function avalHTML(valor){
  return `<div class="stars" id="c-stars">
      ${[1,2,3,4,5].map(n=>`<button type="button" class="star" onclick="setAval(${n})" title="${n}"><span>★</span></button>`).join('')}
      <input type="text" id="c-aval" inputmode="decimal" autocomplete="off" placeholder="—"
        aria-label="Nota, de 1 a 5" value="${valor?avalFmt(valor):''}" oninput="avalPintar()">
    </div>
    <div class="stars-l" id="c-stars-l">${AVAL_VAZIO}</div>`;
}
function avalPintar(){
  const inp=document.getElementById('c-aval');if(!inp)return;
  const v=avalLer(inp.value),ok=v!=null&&!isNaN(v);
  document.querySelectorAll('#c-stars .star').forEach((b,i)=>{
    const p=ok?Math.min(1,Math.max(0,v-i)):0;   // quanto DESTA estrela está cheio
    b.classList.toggle('on',p>=1);
    b.classList.toggle('parte',p>0&&p<1);
    b.style.setProperty('--p',String(p));
  });
  document.getElementById('c-stars-l').textContent=v==null?AVAL_VAZIO
    :isNaN(v)?'A nota vai de 1 a 5, com uma casa decimal (4,2).'
    :estrelas(v)+'  '+avalFmt(v)+' · '+AVAL_TXT[Math.round(v)];
}
function setAval(n){
  const inp=document.getElementById('c-aval');
  inp.value=(avalLer(inp.value)===n)?'':avalFmt(n);
  avalPintar();
}
async function confirmarConsumo(vinhoId){
  if(roGuard())return;
  const gid=parseInt(document.getElementById('c-garrafa').value,10);
  const data=document.getElementById('c-data').value||hoje();
  const nota=document.getElementById('c-nota').value.trim();
  const aval=avalLer(document.getElementById('c-aval').value);
  if(Number.isNaN(aval)){toast('A nota vai de 1 a 5, com uma casa decimal (4,2).',1);return;}
  const btn=document.getElementById('c-btn');
  btn.disabled=true;btn.textContent='A gravar…';
  try{
    // RPC e não PATCH: estado + data têm de entrar juntos (é o que o CHECK
    // `garrafas_consumo_chk` exige), e a função recusa consumir duas vezes a
    // mesma garrafa — o que um duplo toque conseguia fazer. A nota (se
    // vier alguma) é a função que a grava em `consumo_notas` — é a
    // primeira do histórico deste consumo.
    await sbRpc('consumir_garrafa',{
      p_garrafa_id:gid,
      p_data:data,
      p_local:document.getElementById('c-local').value.trim(),
      p_nota:nota,
      p_avaliacao:aval
    });
    const g=db.garrafas.find(x=>x.id===gid);
    if(g)Object.assign(g,{estado:'consumida',consumido_em:data,
      consumo_local:document.getElementById('c-local').value.trim(),
      consumo_avaliacao:aval,
      notas:nota?[{id:null,nota,criado_em:new Date().toISOString()}]:[]});
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
    // O RPC apaga também as linhas de `consumo_notas` desta garrafa — é o
    // mesmo "enganei-me no botão" que já limpava local/nota/avaliação.
    await sbRpc('repor_garrafa',{p_garrafa_id:gid});
    const g=db.garrafas.find(x=>x.id===gid);
    if(g)Object.assign(g,{estado:'na_garrafeira',consumido_em:null,consumo_local:'',consumo_avaliacao:null,notas:[]});
    renderConsumidos();renderLista();refrescarVinhoAberto();
    toast('Garrafa reposta');
  }catch(e){toast('Não foi possível: '+e.message,1);}
}

/* Editar um consumo já registado — engano na data, na nota do Vivino, ou
   só mais um comentário porque o vinho abriu de maneira diferente a meio
   da refeição. Reabre o MESMO modal de "Dar saída", a preencher com o que
   já lá está e sem o seletor de garrafa (já se sabe qual é).

   Data/local/avaliação são um PATCH direto (o CHECK `garrafas_consumo_chk`
   continua a valer: o estado não muda, o `consumido_em` nunca fica vazio).
   As notas são a exceção: NÃO se editam aqui — um vinho tem vários
   momentos ao longo de uma refeição, e cada comentário é a sua própria
   linha em `consumo_notas` (`adicionarNotaConsumo`/`apagarNotaConsumo`),
   nunca um campo que a próxima edição reescreve por cima. */
function editarConsumo(gid){
  if(roGuard())return;
  const g=db.garrafas.find(x=>x.id===gid&&x.estado==='consumida');
  if(!g){toast('Garrafa não encontrada',1);return;}
  const v=IDXV[g.vinho_id]||{nome:'(vinho apagado)'};
  const notas=g.notas||[];
  document.getElementById('modal-consumir-in').innerHTML=`
    <div class="mhero">
      <button class="mx" onclick="fecharModal('modal-consumir')">✕</button>
      <div class="mhero-in">
        <div class="mhero-g">${garrafaSVG(v)}${imagemDe(v)
          ?`<img src="${esc(imagemDe(v))}" alt="" onload="fotoCarregou(this)" onerror="this.remove()">`:''}</div>
        <div class="mhero-tx">
          <div class="mhero-k">Editar consumo</div>
          <h3>${esc(v.nome)}</h3>
          <div class="mhero-s">${esc([v.produtor,v.ano,v.regiao].filter(Boolean).join(' · '))}</div>
        </div>
      </div>
    </div>

    <input type="hidden" id="c-garrafa" value="${gid}">
    <div class="mgar" style="margin-top:14px"><div class="g-onde"><b>📍 ${esc(ondeEsta(g))}</b></div></div>

    <label>Quando</label>
    <input type="date" id="c-data" value="${esc(g.consumido_em||hoje())}">
    <label>Onde / com quem</label>
    <input type="text" id="c-local" value="${esc(g.consumo_local||'')}" placeholder="Jantar de anos, lá em casa">

    <label>Que tal era</label>
    ${avalHTML(g.consumo_avaliacao)}

    <div class="macoes" style="margin-top:14px">
      <button class="btn prim" id="c-btn" onclick="guardarEdicaoConsumo(${gid})">Guardar</button>
      <button class="btn ghost" onclick="fecharModal('modal-consumir')">Cancelar</button>
    </div>

    <label style="margin-top:18px">Comentários (um vinho vai mudando ao longo de uma refeição — acrescenta quantos quiseres)</label>
    <div id="c-notas-lista">${notasEditavelHTML(gid,notas)}</div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input type="text" id="c-nota-nova" style="flex:1;min-width:0" placeholder="Depois de arejar, abriu bem…" onkeydown="if(event.key==='Enter'){event.preventDefault();adicionarNotaConsumo(${gid});}">
      <button class="btn ghost" id="c-nota-add-btn" style="flex:none" onclick="adicionarNotaConsumo(${gid})">+ Acrescentar</button>
    </div>`;
  abrirModal('modal-consumir');
  avalPintar();
}
function notasEditavelHTML(gid,notas){
  if(!notas.length)return '<div class="note" style="padding:6px 0">Ainda sem comentários.</div>';
  return notas.map(n=>`<div class="cc-nota" style="display:flex;gap:6px;align-items:flex-start;justify-content:space-between">
    <span>${notas.length>1?`<b>${esc(dataHoraLocal(n.criado_em).slice(11))}</b> `:''}"${esc(n.nota)}"</span>
    <button type="button" class="jdel" style="flex:none" title="Apagar" onclick="apagarNotaConsumo(${n.id},${gid})">✕</button>
  </div>`).join('');
}
async function adicionarNotaConsumo(gid){
  if(roGuard())return;
  const inp=document.getElementById('c-nota-nova');
  const texto=inp.value.trim();
  if(!texto)return;
  const btn=document.getElementById('c-nota-add-btn');
  btn.disabled=true;
  try{
    const r=await sbReq('POST','consumo_notas',[{garrafa_id:gid,nota:texto}],{'Prefer':'return=representation'});
    const g=db.garrafas.find(x=>x.id===gid);
    if(g){g.notas=g.notas||[];g.notas.push((r||[])[0]||{id:null,nota:texto,criado_em:new Date().toISOString()});}
    document.getElementById('c-notas-lista').innerHTML=notasEditavelHTML(gid,g?g.notas:[]);
    inp.value='';
    renderConsumidos();refrescarVinhoAberto();
  }catch(e){toast('Não foi possível: '+e.message,1);}
  finally{btn.disabled=false;}
}
async function apagarNotaConsumo(notaId,gid){
  if(roGuard())return;
  try{
    await sbReq('DELETE',`consumo_notas?id=eq.${notaId}`);
    const g=db.garrafas.find(x=>x.id===gid);
    if(g)g.notas=(g.notas||[]).filter(n=>n.id!==notaId);
    document.getElementById('c-notas-lista').innerHTML=notasEditavelHTML(gid,g?g.notas:[]);
    renderConsumidos();refrescarVinhoAberto();
  }catch(e){toast('Não foi possível: '+e.message,1);}
}
async function guardarEdicaoConsumo(gid){
  if(roGuard())return;
  const aval=avalLer(document.getElementById('c-aval').value);
  if(Number.isNaN(aval)){toast('A nota vai de 1 a 5, com uma casa decimal (4,2).',1);return;}
  const dados={
    consumido_em:document.getElementById('c-data').value||hoje(),
    consumo_local:document.getElementById('c-local').value.trim(),
    consumo_avaliacao:aval
  };
  const btn=document.getElementById('c-btn');
  btn.disabled=true;btn.textContent='A gravar…';
  try{
    await sbReq('PATCH',`garrafas?id=eq.${gid}`,dados);
    const g=db.garrafas.find(x=>x.id===gid);
    if(g)Object.assign(g,dados);
    fecharModal('modal-consumir');renderConsumidos();refrescarVinhoAberto();
    toast('Consumo atualizado ✓');
  }catch(e){
    toast('Não foi possível: '+e.message,1);
    btn.disabled=false;btn.textContent='Guardar';
  }
}

/* ── MODAL DA GARRAFA (mover / acrescentar / apagar) ───────────────── */
function abrirGarrafa(gid,vinhoId){
  if(roGuard())return;
  const g=gid?db.garrafas.find(x=>x.id===gid):null;
  const vid=g?g.vinho_id:vinhoId;
  const v=IDXV[vid];if(!v)return;
  // Sem nenhum local desenhado não se escolhe local nem lugar: os campos
  // ficam escondidos (com o valor de agora, que se grava igual).
  const comLocal=temLocaisDesenhados();
  const locOpts=db.locais.map(l=>
    `<option value="${l.id}"${g&&g.local_id===l.id?' selected':''}>${esc(l.nome)}</option>`).join('');
  document.getElementById('modal-garrafa-in').innerHTML=`
    <div class="mtop"><div><h3>${gid?(comLocal?'Mover garrafa':'Garrafa'):'Acrescentar garrafa'}</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome)} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-garrafa')">✕</button></div>
    <div class="mrow">
      <div${comLocal?'':' style="display:none"'}><label>Local</label><select id="g-local">${!comLocal&&(!g||g.local_id==null)?'<option value="" selected></option>':''}${locOpts||'<option value="">(cria um local primeiro)</option>'}</select></div>
      ${gid?'':'<div><label>Quantas</label><input type="number" id="g-qtd" value="1" min="1" max="60" inputmode="numeric"></div>'}
    </div>
    <div id="g-slotpick"${comLocal?'':' style="display:none"'}></div>
    <div class="mrow"${comLocal?'':' style="display:none"'}>
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
    ${/* A MESMA pele do "Encaixa na de baixo"/"Cabe uma garrafa à direita"
         do editor do local (`ll-enc`) e não um `.chk` genérico: dentro de
         um modal, `.mbox label` ganha a um `.chk` (duas classes contra uma)
         e punha o rótulo em MAIÚSCULAS a 10px, em bloco e sem quebrar
         linha — saía pela borda do cartão fora ("VEM …") com a caixa
         nativa azul por baixo. É o mesmo visto, tem de se ver igual. */
      TEM_CAIXA_MADEIRA?`<label class="ll-enc"><input type="checkbox" id="g-caixa"${g&&g.caixa_madeira?' checked':''}><span>Vem em caixa de madeira</span></label>
    <div class="note g-caixa-nota">O lugar desta garrafa desenha-se em madeira em vez do círculo — em qualquer nível, e é a ela que pertence, não ao local.</div>`:''}
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
  if(TEM_CAIXA_MADEIRA){
    const cx=document.getElementById('g-caixa');
    dados.caixa_madeira=!!(cx&&cx.checked);
  }
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
      // Um vinho com garrafas já não é um desejo. A página de um desejo não
      // mostra este botão (tem o "Passar para a garrafeira"), mas uma
      // garrafa que chegue por outro caminho não pode deixar a marca ligada.
      const vd=IDXV[vinhoId];
      if(desejado(vd)){
        await sbReq('PATCH',`vinhos?id=eq.${vinhoId}`,{desejado:false});
        vd.desejado=false;
      }
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
  const opts=db.vinhos.filter(v=>!desejado(v)).sort((a,b)=>
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
   (`iaUltimaProcura`, perguntado em `pqIA`). */

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
/* Irmã do `iaPedir`, para VÁRIOS vinhos de uma vez — manda `vinhos` em vez
   de `nome`/`ano`/etc., e a função do lado do servidor (`vinho-info.ts`)
   trata isso como um pedido de LOTE: catálogo vinho a vinho, e no máximo
   UMA chamada ao Gemini para todos, nunca uma por vinho. Devolve
   `{resultados:[{id,encontrado,...}]}`, a mesma forma que a pesquisa manual
   em lote já produz depois de colar a resposta — dá para tratar as duas
   pelo mesmo caminho a seguir (`loteMostrarAtual`). */
async function iaPedirLote(vinhos,campos,motor){
  motor=motor==='premium'?'premium':'gratis';
  await iaLog('pedido',{pedido:{vinhos:vinhos.map(v=>v.id),campos},plano:planoIA(),motor,lote:vinhos.length});
  let r;
  try{
    r=await sbFetch(`${SB_URL}/functions/v1/vinho-info`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({
        assincrono:true,plano:motor,campos,
        vinhos:vinhos.map(v=>({id:v.id,nome:v.nome,ano:v.ano||null,produtor:v.produtor||'',regiao:v.regiao||'',tipo:v.tipo||''})),
      })
    });
  }catch(e){
    await iaLog('erro',{passo:'fetch-lote',erro:String(e.message)});
    throw new Error('Não foi possível falar com o servidor. Sem rede?');
  }
  let d={};try{d=await r.json();}catch(_){}
  if(!r.ok){
    await iaLog('erro',{passo:'http-lote',status:r.status,erro:d.error||''});
    throw new Error(d.error||('O servidor respondeu HTTP '+r.status));
  }
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

/* O link do Vivino só no formato que o Vivino usa: `/<nome>/w/<nº>`, limpo
   de país, língua e ?year=. `/Wines/<nome>`, `/pt-pt/<nome>` sem número e
   afins são o que um modelo escreve de memória — nunca existiram, e
   entravam na ficha a partir ao abrir. `/wines/<nº>` é de UMA colheita.
   A MESMA regra do `vivinoLink` da `vinho-info.ts`. */
function vivinoLink(u){
  try{
    const url=new URL(String(u??'').trim());
    if(!/(^|\.)vivino\.com$/i.test(url.hostname))return '';
    const m=url.pathname.match(/\/([a-z0-9-]+)\/w\/(\d+)/i);
    return m?`https://www.vivino.com/${m[1].toLowerCase()}/w/${m[2]}`:'';
  }catch(_){return '';}
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
// Marca de origem para uma pesquisa MANUAL — o utilizador procura onde
// quiser (Gemini, ChatGPT, Claude…), por isso não se finge saber qual foi;
// só se regista que foi uma pesquisa a sério, colada à mão. `iaUltimaProcura`
// reconhece este prefixo tal como reconhece "gemini" — as duas são pesquisas
// reais, só muda quem apertou o botão de pesquisar.
const IA_MANUAL_MARCA='pesquisa manual (colado à mão)';

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
  if(v.ai_atualizado_em&&/^(gemini|pesquisa manual)/i.test(String(v.ai_modelo||'')))
    cands.push({quando:v.ai_atualizado_em,minha:false});
  if(!cands.length)return null;
  cands.sort((x,y)=>new Date(y.quando)-new Date(x.quando));
  const u=cands[0];
  const dias=(Date.now()-new Date(u.quando).getTime())/86400000;
  return dias<IA_AVISO_DIAS?u:null;
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
/* O catálogo com outra colheita: só servem os factos estáveis — a nota, o
   preço, a imagem e a janela são DAQUELA colheita (`winecatalog.da_colheita`,
   que aqui se repete à mão por ser uma lista curta; se ela mudar, muda esta).
   A nota de TODAS as colheitas (`vivino_nota_global`) não está aqui de
   propósito: é do vinho, não de um ano, e serve a qualquer colheita. O ANO
   nunca vem do catálogo nem da IA — é de quem escreve (ver `pqChaves`). */
const CAT_DA_COLHEITA=['vivino_nota','vivino_avaliacoes','vivino_url','preco_medio','imagem_url','precos','beber_de','beber_ate'];


/* Campos que a IA pode trazer, na ordem em que fazem sentido a ler.
   `rot` é o rótulo; `fmt` só existe onde o valor cru não se lê bem. */
/* A JANELA DE CONSUMO SÓ EXISTE COM COLHEITA. "Beber entre 2026 e 2034" são
   anos de UMA colheita; num vinho sem ano (é o normal na wishlist) seriam os
   de uma colheita qualquer, e no ano em que sair a seguinte continuavam a
   dizer o mesmo. Por isso não se pede, não se propõe nem se grava sem ano —
   e a BD garante-o (trigger `vinhos_sem_colheita`, migração 16), tal como o
   catálogo (`winecatalog.da_colheita`). */
const IA_JANELA=['beber_de','beber_ate'];
function iaCamposPara(v){
  return (v&&v.ano)?IA_CAMPOS:IA_CAMPOS.filter(c=>!IA_JANELA.includes(c.k));
}
/* Pedir a nota do Vivino da colheita traz também a de todas (vêm da mesma
   página); sem colheita só existe a de todas. Espelho do `camposComGlobal`
   da vinho-info.ts. `ano` undefined (o lote) fica com as duas. */
const IA_PAR_VIVINO={vivino_nota:'vivino_nota_global',vivino_avaliacoes:'vivino_avaliacoes_global'};
function iaCamposComGlobal(campos,ano){
  if(!campos)return campos;
  const out=new Set();
  campos.forEach(k=>{
    if(k in IA_PAR_VIVINO){out.add(IA_PAR_VIVINO[k]);if(ano!==null)out.add(k);}
    else out.add(k);
  });
  return [...out];
}
function janelaSincronizarForm(){
  const a=document.getElementById('e-ano');
  const sem=!a||inteiro(a.value)==null;
  const j=document.getElementById('e-jan'), n=document.getElementById('e-jan-nota');
  if(j)j.style.display=sem?'none':'';
  if(n)n.style.display=sem?'':'none';
}
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
  {k:'vivino_nota',rot:'Nota Vivino (colheita)'},
  {k:'vivino_avaliacoes',rot:'Avaliações Vivino (colheita)'},
  // A de TODAS as colheitas: desde 27/09/2026 a pesquisa também a pede (ver
  // `regraVivino` na vinho-info.ts); até aí ia parar à da colheita.
  {k:'vivino_nota_global',rot:'Nota Vivino (todas as colheitas)'},
  {k:'vivino_avaliacoes_global',rot:'Avaliações Vivino (todas as colheitas)'},
  {k:'preco_medio',rot:'Preço de referência (€)'},
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
/* ── De onde é que isto veio ──
   Uma resposta que chega num instante e sem espera parece uma avaria — ou
   pior, parece que a app inventou. Não inventou: veio do CATÁLOGO
   PARTILHADO (schema `catalogo`), a memória comum desta app e da
   WineSelection. Alguém já procurou este vinho, ou tem-no em casa com a
   ficha feita, e por isso esta procura não custou nada.

   `origem:'catalogo'` é a ficha inteira de lá; `'misto'` é parte de lá e
   parte da IA (a IA foi chamada só pelo que faltava — que é também por que
   é que a resposta veio mais depressa e mais barata). Dizer qual é qual, e
   quando é que o catálogo aprendeu aquilo, é o mínimo para se poder
   confiar nisto sem pensar duas vezes. */
// O que a procura POUPOU só interessa a quem paga a conta. Para os outros
// o catálogo tem de ser invisível: eles pediram uma ficha e receberam uma
// ficha — de onde ela veio, e que não custou nada, é contabilidade da app,
// não informação sobre o vinho. Fica em `.admin-hide` (body.naoadmin) e
// não num `if`, para seguir a mesma convenção do resto da app.
function iaOrigemHTML(res){
  if(!res||(res.origem!=='catalogo'&&res.origem!=='misto'))return '';
  const d=res.catalogoEm?new Date(res.catalogoEm):null;
  const quando=(d&&!isNaN(d))?d.toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'}):'';
  const tudo=res.origem==='catalogo';
  const nCampos=Array.isArray(res.catalogoCampos)?res.catalogoCampos.length:0;
  const oque=tudo
    ?'Isto já se sabia'
    :('<b>'+nCampos+'</b> '+(nCampos===1?'campo já se sabia':'campos já se sabiam'));
  const cauda=tudo
    ?' — não foi preciso pesquisar nada, e não custou nada.'
    :' — a pesquisa foi só pelo que faltava.';
  return `<div class="ia-cat admin-hide">🗃️ ${oque}${quando?', de uma pesquisa de '+esc(quando):''}${cauda}</div>`;
}

/* ── DE MEMÓRIA OU PESQUISADO (só o admin vê) ──
   Com o grounding ligado, o Gemini decide sozinho se pesquisa no Google — e
   muitas vezes responde com o que aprendeu no treino (`pesquisaWeb:false`,
   ver o `vinho-info.ts`). Para toda a gente fica como está; ao admin
   diz-se, e oferece-se a PESQUISA PROFUNDA: a mesma pergunta, sem cache nem
   catálogo, com a pesquisa feita pela Edge Function (Serper) e o Gemini só
   a ler os resultados — garantida, ao contrário do grounding. A função
   volta a confirmar o admin. */
function iaMemoriaHTML(res,acao){
  if(!isAdmin()||!res||res.pesquisaWeb!==false)return '';
  return `<div class="ia-prbar"><span>🧠 O Gemini respondeu <b>de memória</b>, sem pesquisa Google. Costuma acertar em vinhos conhecidos, mas pode estar desatualizado.</span>
    <button class="mini o" onclick="${acao}">🔬 Pesquisa profunda</button></div>`;
}
async function iaProfunda(){
  if(!isAdmin()||!IA_PEDIDO||!IA_VINHO)return;
  const v=IDXV[IA_VINHO]||{};
  IA_RES2=null;IA_MOTOR2='';IA_ERRO2='';IA_MOTOR='premium';
  iaMostrarEspera(v.nome+(v.ano?' '+v.ano:'')+' · pesquisa profunda','premium');
  try{
    iaMostrarResultado(await iaPedir(Object.assign({},IA_PEDIDO,{profunda:true}),IA_VINHO,'premium'),IA_VINHO);
  }catch(e){iaMostrarErro(e.message);}
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

  const comAno=v.ano||IA_RES.ano||(IA_RES2&&IA_RES2.ano);
  const linhas=IA_CAMPOS.map(c=>{
    if(!comAno&&IA_JANELA.includes(c.k))return '';          // sem colheita não há janela
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
        ${ant?`<span class="ia-antes">${escLink(ant)}</span> → `:''}${escLink(txt)}
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
      <span><i>${esc(rot)}</i>${escLink(txt)}</span></label>`;
    return `<div class="ia-cmp"><b class="ia-cmp-t">${esc(c.rot)}</b>
      ${op('atual','manter',ant||'(vazio)',' at')}
      ${g?op('r1',rot1,g,cls1):''}
      ${p?op('r2',rot2,p,cls2):''}</div>`;
  }).filter(Boolean).join('');

  const fontesDe=(r,rot)=>r&&r.fontes&&r.fontes.length
    ? `<div class="ia-fontes">Fontes${cmp?' ('+rot+')':''}: ${r.fontes.map(f=>
        `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}</div>`:'';
  const semNet=IA_RES.pesquisa===false||(IA_RES2&&IA_RES2.pesquisa===false);
  // Só vale sugerir o OUTRO motor a quem ainda não usou o premium (grounding
  // search): esse já pesquisa o Google por dentro, e o motor "sem pesquisa
  // web" é outra API por cima do MESMO Google — raramente vai encontrar algo
  // que o grounding não tenha visto. Sugerir isso depois de uma pesquisa
  // premium bem sucedida era pedir desculpa por um resultado que estava bem.
  // (A saída para o outro motor quando o premium FALHA tecnicamente continua
  // em `iaMostrarErro` — aí sim é um caminho a sério, não uma segunda opinião.)
  const valeAOutro=IA_MOTOR==='gratis';

  const loteProg=IA_LOTE_ATIVO?` · ${LOTE_IDX+1}/${LOTE_FILA.length}`:'';
  const loteSaltarBtn=IA_LOTE_ATIVO?'<button class="btn ghost" onclick="loteSaltar()">Saltar »</button>':'';
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><div><h3>${cmp?esc(rot1)+' vs '+esc(rot2):'O que se encontrou'}</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome||'')} ${v.ano||''}${loteProg}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>

    ${iaOrigemHTML(IA_RES)}
    ${!cmp?iaMemoriaHTML(IA_RES,'iaProfunda()'):''}
    ${IA_ERRO2?`<div class="erro">A segunda opinião não deu: ${esc(IA_ERRO2)}. Fica o que a ${esc(rot1)} trouxe.</div>`:''}
    ${!cmp&&temPremium()&&valeAOutro&&linhas?`<div class="ia-prbar">
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
        ${loteSaltarBtn}
        <button class="btn ghost" onclick="fecharModal('modal-ia')">${IA_LOTE_ATIVO?'Parar aqui':'Cancelar'}</button>
      </div>`
    :`<div class="note" style="margin-top:14px">A procura não trouxe nada de novo — o que está na ficha já bate certo com o que se encontrou.</div>
      <div class="macoes">${!cmp&&temPremium()&&valeAOutro&&!IA_LOTE_ATIVO?`<button class="btn ghost" onclick="iaSegundaOpiniao()">✨ Tentar com a ${esc(rotuloMotor(motorOposto(IA_MOTOR)))}</button>`:''}
        ${loteSaltarBtn}
        <button class="btn ghost" onclick="fecharModal('modal-ia')">${IA_LOTE_ATIVO?'Parar aqui':'Fechar'}</button></div>`}

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
  if(('ano' in patch?patch.ano:v.ano)==null)IA_JANELA.forEach(k=>delete patch[k]);
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
    // O produtor que a IA trouxer passa pelo mesmo arrumo da BD (ver guardarVinho).
    const r=await sbReq('PATCH',`vinhos?id=eq.${IA_VINHO}`,patch,{'Prefer':'return=representation'});
    Object.assign(v,patch,(r&&r[0])||{});
    if(castasNovas){
      await sbRpc('definir_castas',{p_vinho_id:IA_VINHO,p_nomes:castasNovas});
      v.castas=castasNovas.slice().sort((a,b)=>a.localeCompare(b,'pt'));
      await recarregarCastas();
    }
    // A meio de um lote, guardar não fecha — avança para o vinho seguinte
    // (ou fecha sozinho, se este era o último). `loteAoFecharModalIA` é que
    // arruma o estado no fim; fora de um lote, o caminho é o de sempre.
    if(IA_LOTE_ATIVO){
      renderLista();
      loteAvancar();
    }else{
      fecharModal('modal-ia');renderLista();refrescarVinhoAberto();
      toast('Ficha atualizada ✓');
    }
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
  // O ANO NÃO: é de quem escreve. Uma procura sem ano que devolvesse um
  // (o do catálogo, ou o que a IA achou) era inventar a colheita da garrafa.
  por('e-produtor',res.produtor);
  por('e-tipo',res.tipo);por('e-estilo',res.estilo);
  por('e-regiao',res.regiao);por('e-subregiao',res.sub_regiao);
  por('e-mencao',res.mencao);por('e-classificacao',res.classificacao);
  por('e-castas',res.castas);
  por('e-estagio',res.estagio_meses);por('e-estagio-txt',res.estagio_texto);
  por('e-teor',res.teor);
  por('e-beber-de',res.beber_de);por('e-beber-ate',res.beber_ate);
  janelaSincronizarForm();
  por('e-preco',res.preco_medio);por('e-vivino',res.vivino_nota);
  por('e-vivino-g',res.vivino_nota_global);
  // O link do Vivino TEM campo no formulário: vai para lá, à vista. Ia só
  // para o `_iaExtraNovo` — o campo ficava em branco e, ao gravar, o que lá
  // estivesse escrito à mão era tapado pelo da procura (ou por nada).
  por('e-vivino-url',res.vivino_url?vivinoLink(res.vivino_url):'');
  por('e-imagem',res.imagem_url);por('e-harmonizacao',res.harmonizacao);
  por('e-vivino-av',res.vivino_avaliacoes);por('e-vivino-av-g',res.vivino_avaliacoes_global);
  por('e-pais',res.pais);por('e-resumo',res.ai_resumo);por('e-notas-prova',res.notas_prova);
  // O carimbo da procura só entra quando o vinho for gravado (não é um
  // campo do formulário) — fica aqui à espera disso. Por cima do que já lá
  // estava (o catálogo antes da IA).
  const ant=_iaExtraNovo||{};
  _iaExtraNovo={
    ai_fontes:res.fontes||ant.ai_fontes||null,ai_modelo:res.modelo||ant.ai_modelo||'',
    ai_atualizado_em:new Date().toISOString()
  };
}

/* ── PROCURAR INFORMAÇÃO, POR ETAPAS ──────────────────────────────────
   Era um labirinto: ao admin, uma escolha de três caminhos (catálogo,
   automática, manual) antes de saber o que faltava; a cada caminho o seu
   ecrã de revisão; e no vinho novo uma pilha de notas e botões que
   apareciam e desapareciam conforme o resultado (26/09/2026, o dono das
   apps). Ficou em DUAS etapas, sempre pela mesma ordem e no mesmo ecrã
   (`modal-ia`), revistas a 27/09/2026 com ele:
     1. CATÁLOGO — corre sozinho ao abrir, é grátis. Mostra os CANDIDATOS
        (`winecatalog.colheitas`: todas as colheitas do vinho, com a cor
        tirada dos dois lados e o produtor como um "contém") numa lista com
        o nome, o ano, as castas e o produtor; o do ano escrito vem
        destacado. Escolhe-se um — ou "Nenhum destes".
     2. IA — uma procura só, depois de escolher COMO (`pqTipo`, 30/09/2026):
        só em sites concretos (um link colado, ou a lista das lojas do
        "Procurar links", só a pedido), ou perguntar à IA — que no pacote completo faz,
        na Edge Function e de seguida, o Serper e depois o grounding pelo que
        ele não trouxe, e no intermédio só o grounding.
   A resposta colada de outro assistente saiu daqui: vive no Editar
   (`formManualAbrir`), ao lado de onde se escreve à mão.

   No VINHO NOVO (e na wishlist) o catálogo vai direto para os campos
   VAZIOS do formulário (escolher o vinho dele é a confirmação); o que a IA
   trouxer passa primeiro pela lista do que se encontrou, e só o que ficar
   marcado vai para o formulário (`pqPassarForm`), que se abre inteiro para
   gravar. Num vinho JÁ GRAVADO há valores de alguém a proteger, por isso
   cada fonte só acrescenta PROPOSTAS (`PQ.hist[campo][fonte]`) a essa
   lista, e nada entra sem Guardar. A lista é o ecrã da WineCatalog
   (29/09/2026): uma linha por campo, o de agora riscado → o encontrado, e
   de que página veio. Vêm marcados os campos vazios (a fonte mais forte,
   `PQ_FORCA`, quando há duas).

   Fechar a janela a meio não perde nada: `PQ` fica, e o mesmo botão
   retoma — com a pesquisa ainda a correr, ou já acabada e por rever. Por
   isso o resultado tem de ter a sua saída para trás: "‹ Pesquisar de outra
   forma" (`pqOutraPesquisa`) deita fora o que a IA trouxe e volta à escolha.

   A atualização massiva (lote) continua com o seu ecrã
   (`iaMostrarResultado`/`iaAplicar`): é outra pergunta, vinho a vinho. */
const PQ_NOMES={cat:'Catálogo',ia:'IA'};
// Num campo vazio, qual das propostas vem escolhida.
const PQ_FORCA=['cat','ia'];
// O formulário de vinho novo: que campo do ecrã recebe cada chave. O que
// não está aqui não se propõe no vinho novo.
const PQ_FORM={produtor:'e-produtor',estilo:'e-estilo',regiao:'e-regiao',sub_regiao:'e-subregiao',
  mencao:'e-mencao',classificacao:'e-classificacao',castas:'e-castas',estagio_meses:'e-estagio',
  estagio_texto:'e-estagio-txt',teor:'e-teor',beber_de:'e-beber-de',beber_ate:'e-beber-ate',
  preco_medio:'e-preco',vivino_nota:'e-vivino',vivino_nota_global:'e-vivino-g',
  vivino_url:'e-vivino-url',imagem_url:'e-imagem',harmonizacao:'e-harmonizacao',
  vivino_avaliacoes:'e-vivino-av',vivino_avaliacoes_global:'e-vivino-av-g',pais:'e-pais',
  ai_resumo:'e-resumo',notas_prova:'e-notas-prova'};
let PQ=null;

function pqVazio(x){return x==null||x===''||(Array.isArray(x)&&!x.length);}
function pqTxt(x){return pqVazio(x)?'':Array.isArray(x)?x.join(', '):String(x);}
function pqRot(k){const c=IA_CAMPOS.find(c=>c.k===k);return c?c.rot:catNome(k);}
/* Os campos que se podem propor. Nunca o ANO (é de quem escreve, ou da
   colheita escolhida) nem a COR (confirma-se antes de procurar). */
function pqChaves(P){
  const ks=[...IA_CAMPOS.map(c=>c.k),...Object.keys(CAT_NOMES)]
    .filter((k,i,a)=>a.indexOf(k)===i&&k!=='ano'&&k!=='tipo');
  return ks.filter(k=>{
    if(!P.id.ano&&IA_JANELA.includes(k))return false;          // sem colheita não há janela
    if(P.novo)return k in PQ_FORM;
    return true;
  });
}
// Os que se podem PEDIR à IA (o catálogo sabe mais do que ela pergunta).
// Sem colheita, a nota do Vivino da colheita não se pede: só a de todas.
function pqChavesIA(P){return pqChaves(P).filter(k=>IA_CAMPOS.some(c=>c.k===k)&&(P.id.ano||!(k in IA_PAR_VIVINO)));}

function pqAtualVinho(v){
  const a={};
  Object.keys(CAT_NOMES).concat(IA_CAMPOS.map(c=>c.k)).forEach(k=>{a[k]=k==='castas'?(v.castas||[]):v[k];});
  return a;
}
function pqAtualForm(){
  const a={};
  Object.entries(PQ_FORM).forEach(([k,id])=>{const e=document.getElementById(id);a[k]=e?e.value.trim():'';});
  return a;
}
function pqNovoEstado(novo,id,atual){
  return {novo,vid:novo?null:id.vid,id,atual,hist:{},iguais:new Set(),esc:{},et:{},res:{},
    fase:'cat',corre:'',repetir:null,escolher:null,tipo:null,sites:[],sitesPedido:[],soSites:false,notas:'',colheitaEsp:false,pedidoCampos:null,
    ultima:'',preenchidos:{},cat:null};
}
// Ainda há alguma coisa a fazer com esta procura (a correr, ou por rever)?
function pqPendente(P){return !!P&&(!!P.corre||!!P.escolher||Object.keys(P.hist).length>0);}

/* Vinho já gravado: o botão "Procurar informação" da página do vinho. */
function iaAbrirProcura(vinhoId){
  if(vinhoId<0)return catAbrirProcura(vinhoId);
  if(roGuard())return;
  const v=IDXV[vinhoId];if(!v)return;
  if(PQ&&!PQ.novo&&PQ.vid===vinhoId&&pqPendente(PQ)){abrirModal('modal-ia');pqPintar();return;}
  PQ=pqNovoEstado(false,{vid:vinhoId,nome:v.nome,ano:v.ano||null,produtor:v.produtor||'',
    regiao:v.regiao||'',tipo:v.tipo||''},pqAtualVinho(v));
  abrirModal('modal-ia');
  // Um vinho já LIGADO ao catálogo (`catalogo_id`, migração 28) não volta a
  // escolher candidatos: já se sabe qual é a linha, e o que ela tem chega cá
  // sozinho (o "≠ catálogo" e as fichas × catálogo). Vai direto à IA.
  if(v.catalogo_id){PQ.fase='ia';PQ.et.cat={estado:'ligado'};pqPintar();return;}
  pqCatalogo();
}
/* Um vinho do CATÁLOGO (30/09/2026, o dono das apps: "dentro do Catálogo,
   quando entro no detalhe de um vinho, não tenho opção de procurar
   informação"). Só a quem pode corrigir o catálogo — os curadores e o admin
   dele (`catPodeCriar`) — e com IA. É o mesmo ecrã, sem a etapa do Catálogo
   (É a linha) nem a da cor (é do catálogo), e o que se guardar corrige a
   LINHA para toda a gente, pela `winecatalog.editar` (`pqGuardarCat`).
   Nem uma frase a dizer que o vinho é do Catálogo: estando no Catálogo, não
   diz nada a ninguém (o dono, 30/09/2026) — a revisão diz só que o que se
   guardar muda o vinho para toda a gente. */
function catAbrirProcura(vinhoId){
  const v=IDXV[vinhoId];if(!v||!(v.id<0))return;
  if(!catPodeCriar()){toast('Só os curadores do catálogo podem corrigir um vinho do catálogo',1);return;}
  if(PQ&&PQ.cat===v.cat_id&&pqPendente(PQ)){abrirModal('modal-ia');pqPintar();return;}
  PQ=pqNovoEstado(false,{vid:vinhoId,nome:v.nome,ano:v.ano||null,produtor:v.produtor||'',
    regiao:v.regiao||'',tipo:v.tipo||''},pqAtualVinho(v));
  PQ.cat=v.cat_id;PQ.fase='ia';PQ.et.cat={estado:'proprio'};
  abrirModal('modal-ia');
  pqPintar();
}
/* Vinho novo (e wishlist): o mesmo ecrã por cima do formulário compacto.
   No Catálogo (`FORM_CAT`), a 1.ª etapa são os vinhos PARECIDOS
   (`catParecidos`), e também antes de "Preencher à mão" (`soVer`: só essa
   etapa, e depois o formulário) — criar um vinho que já lá está é o que
   não pode acontecer. */
function pqAbrirNovo(soVer){
  const nome=document.getElementById('e-nome').value.trim();
  if(!nome){toast('Escreve primeiro o nome do vinho',1);document.getElementById('e-nome').focus();return;}
  // A cor antes de procurar: é ela que separa o tinto do
  // branco do mesmo nome, e o catálogo ainda não a tem na chave.
  const elTipo=document.getElementById('e-tipo');
  if(elTipo&&!elTipo.value){toast('Escolhe primeiro a cor do vinho',1);elTipo.focus();return;}
  const id={vid:null,nome,ano:inteiro(document.getElementById('e-ano').value),
    produtor:document.getElementById('e-produtor').value.trim(),regiao:'',tipo:elTipo?elTipo.value:''};
  if(!soVer&&PQ&&PQ.novo&&!PQ.soVer&&(PQ.corre||PQ.fase==='fim')&&PQ.id.nome===nome){abrirModal('modal-ia');pqPintar();return;}
  PQ=pqNovoEstado(true,id,pqAtualForm());
  PQ.naCat=FORM_CAT;PQ.soVer=!!soVer&&FORM_CAT;
  abrirModal('modal-ia');
  pqCatalogo();
}

/* Acrescenta as propostas de uma fonte. Devolve quantos campos ela
   PREENCHEU de novo (vazios agora e sem proposta de ninguém antes), em
   quantos sugere outra coisa do que lá está, e em quantos discorda de
   outra fonte — é o que as mensagens contam. */
function pqJuntar(P,fonte,res){
  let novos=0,dif=0,outro=0;
  pqChaves(P).forEach(k=>{
    const val=res[k];
    if(pqVazio(val))return;
    if(k==='vivino_url'&&!vivinoLink(val))return;
    const agora=P.atual[k];
    if(!pqVazio(agora)&&chave(pqTxt(val))===chave(pqTxt(agora))){P.iguais.add(k);return;}
    const h=P.hist[k]||(P.hist[k]={});
    const antes=Object.values(h);
    h[fonte]=k==='vivino_url'?vivinoLink(val):val;
    if(!pqVazio(agora))dif++;
    else if(!antes.length)novos++;
    else if(!antes.some(x=>chave(pqTxt(x))===chave(pqTxt(val))))outro++;
  });
  return {novos,dif,outro};
}

/* ── VINHOS PARECIDOS NO CATÁLOGO (30/09/2026, o dono das apps) ──
   A criar um vinho no Catálogo, a pergunta não é "qual destes é o teu?" (o
   da garrafeira) mas "tens a certeza de que ainda não existe?". A
   `colheitas` só acha o MESMO nome; aqui procura-se no catálogo que já está
   na app (`CAT_VINHOS`) por palavras parecidas: iguais, a uma letra
   ("Cristo"/"Crasto", também duas vizinhas trocadas) ou o princípio de
   outra ("Harvest"/"Harvested"). Tem de bater pelo menos metade das
   palavras do nome que IDENTIFICAM um vinho — nem gama, nem cor, nem casta,
   nem região, nem "quinta" (a ideia da `generico` dos Duplicados) — e, sem
   nenhuma dessas no nome, as do produtor. A semelhança só propõe: quem cria
   é que decide. Outra cor é outro vinho, e fica de fora. */
const PAR_GENERICAS=new Set(('reserva grande garrafeira colheita selecionada seleccionada velhas velha velho '
  +'superior especial premium escolha tinto branco rose espumante frisante licoroso doce seco bruto meio '
  +'unoaked barrica madeira antiga novo private selection edicao limitada safra vindima tardia '
  +'touriga nacional franca roriz tinta aragonez aragones trincadeira castelao baga jaen alfrocheiro alicante '
  +'bouschet syrah shiraz cabernet sauvignon merlot pinot noir chardonnay alvarinho loureiro arinto encruzado '
  +'fernao pires antao vaz verdelho viosinho rabigato gouveio malvasia moscatel sercial bual sousao barroca '
  +'bastardo ramisco avesso azal trajadura esgana cao marufo carignan grenache tempranillo viognier riesling '
  +'semillon petit verdot malbec blend '
  +'quinta quintas herdade monte casa casal solar paco adega adegas cave caves vinho vinhos vinha vinhas wine '
  +'wines estate estates family familia sociedade companhia cooperativa agricola vinicola lda sa company dona dom '
  +'doc regional igp vr douro porto alentejo alentejano dao bairrada lisboa tejo setubal peninsula minho verde '
  +'verdes beira beiras interior tavora varosa tras montes transmontano algarve acores colares bucelas '
  +'carcavelos palmela alenquer obidos encostas reguengos borba evora redondo vidigueira portalegre moura '
  +'cima corgo baixo portugal').split(' '));
function parPalavras(s){return palavrasDesejo(s).filter(t=>!/^(19|20)\d\d$/.test(t));}
// Uma letra trocada, a mais ou a menos, ou duas vizinhas trocadas.
function parUmaLetra(a,b){
  const la=a.length,lb=b.length;
  if(Math.abs(la-lb)>1)return false;
  if(la===lb){
    const d=[];
    for(let i=0;i<la;i++)if(a[i]!==b[i]){d.push(i);if(d.length>2)return false;}
    return d.length===1||(d.length===2&&d[1]===d[0]+1&&a[d[0]]===b[d[1]]&&a[d[1]]===b[d[0]]);
  }
  const [c,l]=la<lb?[a,b]:[b,a];
  let i=0;while(i<c.length&&c[i]===l[i])i++;
  return c.slice(i)===l.slice(i+1);
}
function parPerto(a,b){
  if(a===b)return 1;
  if(Math.min(a.length,b.length)<5)return 0;
  if(parUmaLetra(a,b))return .8;
  const [c,l]=a.length<b.length?[a,b]:[b,a];
  return l.startsWith(c)&&l.length-c.length<=3?.8:0;
}
// Os parecidos, do mais para o menos parecido, na forma da `colheitas`.
function catParecidos(nome,produtor,tipo,max){
  const qn=parPalavras(nome), qp=parPalavras(produtor);
  const q=[...new Set(qn.concat(qp))];
  if(!q.length)return [];
  let fortes=qn.filter(t=>!PAR_GENERICAS.has(t));
  if(!fortes.length)fortes=qp.filter(t=>!PAR_GENERICAS.has(t));
  fortes=[...new Set(fortes)];
  const cor=tipo?chave(tipo):'';
  const out=[];
  (CAT_VINHOS||[]).forEach(v=>{
    if(cor&&v.tipo&&chave(v.tipo)!==cor)return;
    const wn=parPalavras(v.nome), wa=[...new Set(wn.concat(parPalavras(v.produtor)))];
    const perto=t=>wa.reduce((m,w)=>Math.max(m,parPerto(t,w)),0);
    let f=0;
    if(fortes.length){
      fortes.forEach(t=>{f+=perto(t);});
      if(f<fortes.length/2)return;
    }else if(!q.every(t=>perto(t)===1))return;   // só palavras genéricas: todas
    const g=q.filter(t=>!fortes.includes(t)).reduce((s,t)=>s+perto(t),0);
    // As palavras do nome DELE que não se escreveram: "Crasto Reserva" vem
    // antes de "Crasto Reserva Vinhas Velhas".
    const aMais=wn.filter(w=>!q.some(t=>parPerto(t,w))).length;
    out.push({c:{id:v.cat_id,nome:v.nome,produtor:v.produtor||'',ano:v.ano??null,tipo:v.tipo||'',
      castas:v.castas||[],regiao:v.regiao||''},pontos:f*3+g-aMais*.5});
  });
  return out.sort((a,b)=>b.pontos-a.pontos||(b.c.ano||0)-(a.c.ano||0)).slice(0,max||8).map(x=>x.c);
}

/* ── Etapa 1: o catálogo — os candidatos ── */
async function pqCatalogo(){
  const P=PQ;
  P.corre='cat';P.escolher=null;pqPintar();
  let lista=null,erro='';
  try{
    lista=await sbReq('POST','rpc/colheitas',{p_nome:P.id.nome,p_produtor:P.id.produtor||'',p_tipo:P.id.tipo||null},
      {'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'});
  }catch(e){erro=e.message;}
  // No Catálogo, a criar: os do mesmo nome e, a seguir, os parecidos.
  let parecidos=[];
  if(P.naCat){
    try{await catCarregar();}catch(e){}
    parecidos=catParecidos(P.id.nome,P.id.produtor,P.id.tipo);
  }
  if(PQ!==P)return;
  P.corre='';
  if(P.naCat){
    const mesmos=(Array.isArray(lista)?lista:[])
      .filter(c=>!c.tipo||!P.id.tipo||chave(c.tipo)===chave(P.id.tipo))
      .sort((a,b)=>(b.ano===P.id.ano)-(a.ano===P.id.ano));
    const vistos=new Set(), L=[];
    mesmos.concat(parecidos).forEach(c=>{if(c&&c.id!=null&&!vistos.has(c.id)&&L.length<8){vistos.add(c.id);L.push(c);}});
    if(L.length){P.escolher=L;pqPintar();return;}
    P.fase='ia';
    P.et.cat=erro&&!CAT_VINHOS?{estado:'erro',msg:erro}:{estado:'nada'};
    if(P.soVer)pqFimNovo();else pqPintar();
    return;
  }
  // O catálogo é uma poupança, nunca uma dependência: se falhar, segue-se.
  if(erro||!Array.isArray(lista)){P.fase='ia';P.et.cat={estado:'erro',msg:erro||'sem resposta'};pqPintar();return;}
  // Outra cor = outro vinho (o "Papa Figos" tinto não é o branco).
  const mesmaCor=lista.filter(c=>!c.tipo||!P.id.tipo||chave(c.tipo)===chave(P.id.tipo));
  if(!mesmaCor.length){
    P.fase='ia';
    P.et.cat=lista.length?{estado:'cor',nome:lista[0].nome||P.id.nome,cor:String(lista[0].tipo)}:{estado:'nada'};
    pqPintar();return;
  }
  // Mostram-se SEMPRE, mesmo que seja um só: é quem tem a garrafa que diz
  // se é este. O do ano escrito vem primeiro, e destacado.
  P.escolher=mesmaCor.slice().sort((a,b)=>(b.ano===P.id.ano)-(a.ano===P.id.ano));
  pqPintar();
}
function pqColheitaEscolher(i){
  const P=PQ;if(!P||!P.escolher)return;
  const c=P.escolher[i];if(!c)return;
  // A criar no catálogo, o candidato da MESMA colheita (ou escolhido sem ano
  // escrito) é este vinho: já lá está. Abre-se em vez de nascer outra linha.
  if(P.naCat&&FORM_CAT&&c.id&&(P.id.ano==null||c.ano===P.id.ano)){
    PQ=null;fecharModal('modal-ia');fecharModal('modal-edit');FORM_CAT=false;
    toast('Este vinho já está no catálogo');
    catCarregar().then(()=>{if(IDXV[-c.id])verVinho(-c.id);}).catch(()=>{});
    return;
  }
  // Sem ano escrito, a colheita escolhida passa a ser a do vinho: no vinho
  // novo vai para o campo do ano; num vinho gravado sem ano, grava-se com o
  // resto (`PQ.anoEscolhido`).
  if(P.id.ano==null&&c.ano!=null){
    P.id.ano=c.ano;
    if(P.novo){const e=document.getElementById('e-ano');if(e){e.value=String(c.ano);janelaSincronizarForm();}}
    else P.anoEscolhido=c.ano;
  }
  pqCatalogoUsar(c);
}
function pqColheitaNenhum(){
  const P=PQ;if(!P)return;
  P.escolher=null;P.fase='ia';P.et.cat={estado:'recusado'};
  if(P.soVer)pqFimNovo();else pqPintar();
}
async function pqCatalogoUsar(c){
  const P=PQ;
  P.escolher=null;P.corre='cat';pqPintar();
  let r=null,erro='';
  try{
    // O nome, o produtor e o ano DA LINHA escolhida: é assim que a
    // `comparar` devolve essa e não outra (a mesma colheita ganha).
    r=await sbReq('POST','rpc/comparar',{p_nome:c.nome,p_produtor:c.produtor||'',p_ano:c.ano??null,p_ficha:c.tipo?{tipo:c.tipo}:{}},
      {'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'});
  }catch(e){erro=e.message;}
  if(PQ!==P)return;
  P.corre='';P.fase='ia';
  if(erro||!r||!r.encontrado){P.et.cat={estado:'erro',msg:erro||'o catálogo não devolveu a ficha'};if(P.soVer)pqFimNovo();else pqPintar();return;}
  const val={};
  (r.campos||[]).forEach(k=>{if(k&&!pqVazio(k.catalogo))val[k.campo]=k.catalogo;});
  delete val.tipo;delete val.ano;
  // Com ano e outra colheita no catálogo, só servem os factos estáveis.
  const outraColheita=P.id.ano!=null&&r.ano!==P.id.ano;
  if(outraColheita)CAT_DA_COLHEITA.forEach(k=>delete val[k]);
  // No vinho novo, o que o catálogo MOSTROU: se um curador gravar outro
  // valor num destes campos, é uma correção e vai à linha (`curadorNovo`).
  if(P.novo)_catBaseNovo=Object.assign({},val);
  // Os preços das LOJAS não são um campo: a app lê-os do catálogo sempre que
  // carrega (`precos_lojas`). No vinho novo diz-se que existem.
  const lojas=Object.entries(val.precos&&typeof val.precos==='object'?val.precos:{})
    .filter(([,p])=>p&&typeof p==='object'&&!p.retirado&&Number(p.preco)>0)
    .sort((a,b)=>lojaOrdem(a[0])-lojaOrdem(b[0]));
  delete val.precos;
  // O PRODUTOR é identidade: num vinho gravado não vem de lá; num vinho
  // novo sem produtor escrito, vem — e é por isso que o formulário
  // compacto o pode deixar em branco.
  delete val.produtor;
  if(P.novo&&!P.id.produtor&&r.produtor)val.produtor=r.produtor;
  // O vinho novo que veio de um candidato fica com o NOME do catálogo (fase
  // 4 dos nomes): é o nome arrumado — sem produtor à frente, sem cor, sem
  // ano — e é o que faz as garrafeiras e o catálogo escreverem o mesmo
  // vinho da mesma maneira. O produtor também, se o escrito for outra grafia.
  if(P.novo&&r.nome){
    const en=document.getElementById('e-nome');if(en)en.value=r.nome;
    P.id.nome=r.nome;
    const ep=document.getElementById('e-produtor');
    if(ep&&r.produtor&&ep.value.trim()&&chave(ep.value)!==chave(r.produtor)&&chave(r.produtor).includes(chave(ep.value)))ep.value=r.produtor;
  }
  // Um link fora do formato do Vivino não se traz — e diz-se.
  const vivinoMau=val.vivino_url&&!vivinoLink(val.vivino_url)?String(val.vivino_url):'';
  const n=pqJuntar(P,'cat',val);
  P.et.cat={estado:'feito',n:n.novos,dif:n.dif,ano:r.ano,nome:r.nome,produtor:r.produtor,outraColheita,vivinoMau,lojas:P.novo?lojas:[]};
  P.ultima='cat';
  if(P.novo)pqPorNoForm(P,'cat');
  if(P.soVer)pqFimNovo();else pqPintar();
}

/* Os campos escolhidos na lista "O que pedir" (a de agora no ecrã). */
function pqCamposLidos(){
  return [...document.querySelectorAll('#modal-ia-in .pq-campo:checked')].map(e=>e.value);
}
/* As caixas de texto do passo 2 (os links colados e as notas) passam para o
   PQ antes de o ecrã se repintar, que as reescreve. Os links vão inteiros:
   um link colado é uma PÁGINA a ler (e o do Vivino é o link dele); o corte
   ao domínio faz-se na `vinho-info`. */
function pqLerCaixas(){
  const P=PQ;if(!P)return;
  const s=document.getElementById('pq-sites');
  if(s)P.sites=pqColados(s.value);
  const n=document.getElementById('pq-notas');
  if(n)P.notas=n.value.trim().slice(0,300);
}
function pqColados(txt){return String(txt||'').split(/[,\n]/).map(s=>s.trim()).filter(Boolean).slice(0,5);}
// Um link de uma PÁGINA, não só o endereço do site.
function pqEPagina(x){
  try{const u=new URL(/^https?:\/\//i.test(x)?x:'https://'+x);return u.pathname.replace(/\/+$/,'')!==''||!!u.search;}
  catch(e){return false;}
}

/* COMO se procura (30/09/2026, o dono das apps: o primeiro ecrã da
   WineCatalog, "num site ou perguntar à IA"). Dois caminhos, e o segundo
   passo é o de cada um:
     · 'sites' ("Em sites concretos") — SÓ nos sites que se indicam
       (`soSites`, sempre). Começa pela caixa onde se cola o link de 1 ou 2
       páginas; no pacote completo, "Sugere-me sites" abre a lista das lojas
       ("Procurar links"), onde se escolhem até 2. Só a pedido, NUNCA ao
       entrar: cada lista é uma pesquisa Serper, que se paga (o dono).
     · 'ia'    — a pesquisa de sempre, sem sites.
   Os sites "de referência" misturados com a pesquisa geral deixaram de ser
   uma opção no ecrã, como na WineCatalog: não se sabia de onde vinha o quê. */
function pqTipo(t){
  const P=PQ;if(!P)return;
  P.tipo=t;
  pqPintar();
}
// A lista dos sites sugeridos fecha-se sem se perder (voltar a ela não é
// outra pesquisa): o que se marcou lá continua a ir na pesquisa.
function pqLinksVer(ver){
  const P=PQ;if(!P)return;
  pqLerCaixas();
  P.linksVer=!!ver;
  pqPintar();
}
function pqTipoVoltar(){
  const P=PQ;if(!P)return;
  pqLerCaixas();
  P.tipo=null;P.links=null;P.linksMarca=[];P.linksProx=null;
  if(P.et.ia&&P.et.ia.estado==='erro')delete P.et.ia;
  pqPintar();
}
/* Não se gostou do que a pesquisa trouxe (30/09/2026, o dono das apps:
   "quis voltar atrás para fazer outro tipo de pesquisa, e fico encalhado na
   pesquisa anterior"). Depois do resultado não havia caminho de volta, e
   como fechar a janela não perde nada, reabri-la mostrava o mesmo. Isto
   deita fora o que a IA trouxe — as propostas, o que se marcou nelas, os
   campos que vieram iguais — e volta a "Como queres procurar?". O que o
   Catálogo propôs fica: foi a 1.ª etapa, não esta. */
function pqOutraPesquisa(){
  const P=PQ;if(!P||P.corre)return;
  Object.keys(P.hist).forEach(k=>{
    if(!('ia' in P.hist[k]))return;
    delete P.hist[k].ia;delete P.esc[k];
    if(!Object.keys(P.hist[k]).length)delete P.hist[k];
  });
  if(P.antesIA){P.iguais=new Set(P.antesIA.iguais);P.ultima=P.antesIA.ultima;}
  delete P.res.ia;delete P.et.ia;
  P.fase='ia';P.tipo=null;P.linksVer=false;
  pqPintar();
}

/* ── Etapa 2: a IA — uma procura só ── */
async function pqIA(repetir){
  const P=PQ;if(!P)return;
  if(!podeUsarIA()){toast('A pesquisa por IA não está incluída no teu acesso',1);return;}
  if(!repetir){
    const campos=pqCamposLidos();
    if(!campos.length){toast('Escolhe pelo menos um campo',1);return;}
    P.pedidoCampos=campos;
    P.colheitaEsp=!!document.getElementById('pq-colheita')?.checked;
    pqLerCaixas();
    // Nos sites: os links marcados na lista do "Procurar links" e os colados,
    // sem repetir — e é sempre "só estes sites" (ver `pqTipo`).
    const sites=P.tipo==='sites'
      ?[...(P.links?pqLinksMarcados(P):[]),...P.sites].filter((s,i,a)=>a.indexOf(s)===i).slice(0,5):[];
    if(P.tipo==='sites'&&!sites.length){
      toast(P.links?'Marca um link da lista, ou cola o de uma página':'Cola o link da página do vinho',1);
      document.getElementById('pq-sites')?.focus();
      return;
    }
    // Links concretos (o dono, 30/09/2026): só o site, sem a página, obrigava
    // a procurar lá o vinho — uma pesquisa Serper que ninguém pediu.
    const soSite=P.tipo==='sites'?P.sites.filter(x=>!pqEPagina(x)):[];
    if(soSite.length){
      toast(`“${soSite[0]}” é só o site: cola o link da página do vinho`,1);
      document.getElementById('pq-sites')?.focus();
      return;
    }
    P.sitesPedido=sites;P.soSites=P.tipo==='sites';
    if(!P.novo&&!P.cat){
      // A cor é a do vinho: gravar um vinho já a exige (fase 4 dos nomes),
      // e deixou de se confirmar aqui (o dono, 30/09/2026).
      const v=IDXV[P.vid];if(!v)return;
      const cor=v.tipo||'';
      if(!cor){toast('Falta a cor deste vinho: escolhe-a no Editar',1);return;}
      P.id.tipo=cor;
      // Cada procura custa dinheiro, e a ficha de um vinho não muda de uma
      // semana para a outra: se foi há pouco, pergunta-se (`iaUltimaProcura`).
      // Não depois de "Pesquisar de outra forma": a última foi a que se acabou
      // de deitar fora, e voltar atrás já foi a decisão.
      const ult=P.jaPesquisou?null:await iaUltimaProcura(P.vid);
      if(PQ!==P)return;
      if(ult){P.repetir=ult;pqPintar();return;}
    }
  }
  P.repetir=null;
  // No vinho novo, o "agora" de cada campo é o que o formulário tem neste
  // momento (o catálogo e a pessoa já lá escreveram): é contra isso que se
  // compara o que a IA trouxer.
  if(P.novo)P.atual=pqAtualForm();
  const pedido={nome:P.id.nome,tipo:P.id.tipo};
  if(P.id.ano)pedido.ano=P.id.ano;
  // O produtor que o catálogo trouxe ajuda a IA a acertar no vinho.
  const prod=P.id.produtor||(P.novo?document.getElementById('e-produtor')?.value.trim():'')||'';
  if(prod)pedido.produtor=prod;
  if(P.id.regiao)pedido.regiao=P.id.regiao;
  if(P.pedidoCampos&&P.pedidoCampos.length<pqChavesIA(P).length)pedido.campos=P.pedidoCampos;
  pedido.colheitaEspecifica=P.colheitaEsp;
  if(P.notas)pedido.notas=P.notas;
  if(P.soSites&&P.sitesPedido.length){pedido.sites=P.sitesPedido;pedido.soSites=true;}
  // O resultado do Vivino que a procura de links trouxe vai junto: o link e
  // as estrelas do Google, sem outra pesquisa (o Vivino não se abre).
  if(P.links&&P.linksVivino&&pedido.soSites)pedido.vivinoGoogle=P.linksVivino;
  // A lista já serviu: os sites da pesquisa passam para a caixa, que é com
  // eles que se tenta outra vez se ela falhar.
  if(P.soSites)P.sites=P.sitesPedido.slice();
  P.links=null;P.linksMarca=[];P.linksProx=null;
  P.corre='ia';P.et.ia={estado:'corre'};
  pqPintar();
  try{
    const res=await iaPedir(pedido,P.cat?null:P.vid,motorDoPlano());
    if(PQ!==P)return;
    P.res.ia=res;
    // O que havia antes desta resposta, para a poder deitar fora (`pqOutraPesquisa`).
    P.antesIA={iguais:[...P.iguais],ultima:P.ultima};P.jaPesquisou=true;
    // O que veio sem página, com "só estes sites", não entrou na ficha mas
    // mostra-se na mesma — nunca marcado onde já há valor (`pqDefeito`):
    // quem pede um campo que tem quer ver alternativas (30/09/2026, o dono).
    const sfv=res.semFonteValores&&typeof res.semFonteValores==='object'?res.semFonteValores:{};
    const n=pqJuntar(P,'ia',{...sfv,...res});
    P.et.ia={estado:'feito',n:n.novos,dif:n.dif,outro:n.outro,memoria:res.pesquisaWeb===false,
      sites:Array.isArray(res.sites)?res.sites:[],confianca:res.confianca||null,
      paginas:Array.isArray(res.paginas)?res.paginas:[],soSites:!!res.soSites,
      semFonte:Array.isArray(res.semFonte)?res.semFonte:[],
      origem:res.origemCampos&&typeof res.origemCampos==='object'?res.origemCampos:{},
      catalogoCampos:Array.isArray(res.catalogoCampos)?res.catalogoCampos:[],
      pesquisaWeb:res.pesquisaWeb,modelo:res.modelo||'',
      fontes:Array.isArray(res.fontes)?res.fontes:[],aviso:res.aviso||''};
    P.ultima='ia';P.fase='fim';
  }catch(e){
    if(PQ!==P)return;
    P.et.ia={estado:'erro',msg:e.message};
  }
  P.corre='';
  // No vinho novo também se revê (29/09/2026, o dono das apps — o ecrã da
  // WineCatalog): o que a IA trouxe, campo a campo e de que página, e só o
  // que ficar marcado passa para o formulário (`pqPassarForm`).
  if(!document.getElementById('modal-ia').classList.contains('on'))
    toast('A procura terminou — abre “Procurar informação” para rever o que encontrou');
  pqPintar();
}

/* ── O ecrã ── */
function pqPassoHTML(k,P){
  const e=P.et[k]||{};
  const par=k==='cat'&&P.naCat;
  const st=k==='cat'&&P.escolher?(par?'vê a lista':'escolhe o vinho')
    :P.corre===k?'a procurar…'
    :e.estado==='feito'?(k==='cat'?`✓ ${e.n} ${e.n===1?'campo':'campos'}`:`✓ +${e.n}`)
    :e.estado==='nada'?(par?'nenhum':'não conhece')
    :e.estado==='recusado'?(par?'é novo':'nenhum destes')
    :e.estado==='cor'?'outra cor'
    :e.estado==='ligado'?'✓ já ligado'
    :e.estado==='erro'?'não deu'
    :'—';
  const cls=P.corre===k||(k==='cat'&&P.escolher)?'corre':e.estado==='feito'||e.estado==='ligado'?'feito':e.estado==='erro'?'erro':e.estado?'nada':'';
  return `<div class="pq-passo ${cls}"><b>${esc(par?'Parecidos':PQ_NOMES[k])}</b><span>${esc(st)}</span></div>`;
}
function pqQtd(n,um,varios){return `<b>${n}</b> ${n===1?um:varios}`;}
/* O QUE SE FEZ COM OS SITES DE CONFIANÇA (27/09/2026). A vinho-info procura
   o vinho em cada domínio (no pacote completo, que é o que tem Serper) e LÊ
   a página que encontrar — e as que se colaram, em qualquer pacote —, e diz
   o que aconteceu a cada uma (`paginas`) e quantos resultados vieram de cada
   site (`confianca`); sem nada disso foram só uma frase no pedido à IA, e
   diz-se isso — era o que não se sabia. */
function pqSitesHTML(f){
  const sites=f&&Array.isArray(f.sites)?f.sites:[];
  if(!sites.length)return '';
  const c=f.confianca&&typeof f.confianca==='object'?f.confianca:null;
  const pags=Array.isArray(f.paginas)?f.paginas:[];
  const titulo=f.soSites?'Só estes sites':'Sites de referência';
  if(!c&&!pags.length)return `<div class="ia-fontes">${titulo} (${esc(sites.join(', '))}): foram só no texto do pedido
    à IA — sem a pesquisa Google do pacote completo, não há como confirmar se os usou.</div>`;
  const doSite=(x,d)=>!!x&&(x===d||x.endsWith('.'+d));
  const lnk=p=>p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.titulo||p.url)}</a>`:'';
  const pagFrase=p=>{
    const l=lnk(p);
    if(p.estado==='lida')return `página lida${p.dada?' (a que colaste)':''} — ${l}`;
    if(p.estado==='recusada')return `a página recusou a leitura (${esc(p.motivo||'bloqueio')})${l?' — '+l:''}`;
    if(p.estado==='vazia')return `${esc(p.motivo||'a página não tem texto')}${l?' — '+l:''}`;
    if(p.estado==='nao_encontrada')return 'o vinho não apareceu na procura neste site';
    if(p.estado==='sem_pesquisa')return 'procurar dentro do site é do pacote completo — cola o link da página';
    return `${p.url?'não abriu':'falhou'} (${esc(p.motivo||'erro')})${l?' — '+l:''}`;
  };
  const linhas=sites.map(s=>{
    const ps=pags.filter(p=>doSite(p.site,s));
    const n=c&&s in c?Number(c[s])||0:null;
    const partes=ps.map(pagFrase);
    if(n!==null&&!ps.some(p=>p.estado==='lida'||p.estado==='nao_encontrada'))partes.push(`${n} resultado${n===1?'':'s'} da pesquisa`);
    if(!partes.length)partes.push(n===null?'não é um domínio — só no texto do pedido':'nada');
    return `<li><b>${esc(s)}</b>: ${partes.join(' · ')}</li>`;
  });
  return `<div class="ia-fontes">${titulo}:<ul class="pq-sites">${linhas.join('')}</ul></div>`;
}
/* DE ONDE VEIO cada campo que a IA trouxe (27/09/2026, o dono das apps): a
   página ou o resultado que ela diz ter lido (`origemCampos`), o link do
   Vivino colado, ou a pesquisa Google do grounding — que não diz a página.
   Sem origem não se escreve nada: não se inventa uma. */
function pqDeOndeHTML(o){
  if(!o||typeof o!=='object')return '';
  if(o.google)return 'pesquisa Google';
  if(!o.url)return '';
  return `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.site||o.url)}</a>`;
}
/* Numa linha, os campos agrupados pelo sítio de onde vieram. `so`: só
   estes campos (no vinho novo, os que a IA chegou a pôr no formulário). */
function pqDeOndeResumoHTML(f,so){
  const o=f&&f.origem||{};
  const grupos=new Map();
  Object.keys(o).forEach(k=>{
    if(so&&!so.includes(k))return;
    const h=pqDeOndeHTML(o[k]);if(!h)return;
    const g=grupos.get(h)||[];g.push(pqRot(k));grupos.set(h,g);
  });
  if(!grupos.size)return '';
  return `<div class="ia-fontes">De onde veio: ${[...grupos].map(([h,ks])=>`${h} — ${esc(ks.join(', '))}`).join(' · ')}.</div>`;
}
function pqFontesHTML(fontes){
  return fontes&&fontes.length?`<div class="ia-fontes">Fontes: ${fontes.map(f=>
    `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}</div>`:'';
}
/* O que a última etapa fez, numa ou duas frases. */
function pqRelatoHTML(P){
  const out=[];
  const c=P.et.cat;
  const onde=P.novo?'no formulário':'na lista em baixo';
  if(c&&(P.ultima==='cat'||!P.ultima)){
    if(c.estado==='feito'){
      const qual=`<b>${esc(c.nome)}</b>${c.ano?' '+esc(String(c.ano)):''}${c.produtor?' · '+esc(c.produtor):''}`;
      out.push(c.n
        ?`Do Catálogo (${qual}) vieram ${pqQtd(c.n,'campo','campos')}, já ${onde}.`
        :`O Catálogo (${qual}) não tinha nada que falte a esta ficha.`);
      if(c.dif)out.push(`Tem também outro valor em ${pqQtd(c.dif,'campo que já estava preenchido','campos que já estavam preenchidos')}.`);
      if(c.outraColheita)out.push(P.naCat
        ?`<span class="note">Vais criar a colheita ${esc(String(P.id.ano))} deste vinho: da de ${esc(String(c.ano||'sem ano'))} vieram só os factos do vinho, sem nota, preço nem imagem.</span>`
        :`<span class="note">A tua colheita (${esc(String(P.id.ano))}) não está no Catálogo: vieram só os factos do vinho da colheita ${esc(String(c.ano||'sem ano'))}, sem nota, preço nem imagem.</span>`);
      if(P.anoEscolhido)out.push(`<span class="note">A colheita ${esc(String(P.anoEscolhido))} fica gravada no vinho quando guardares.</span>`);
      if(c.vivinoMau)out.push(`<span class="note">O link do Vivino que o Catálogo tem não está no formato do Vivino — não o trouxe.</span>`);
      if(c.lojas&&c.lojas.length)out.push(`<span class="note">💶 Nas lojas: ${c.lojas.map(([k,p])=>
        `<b>${esc(lojaInfo(k).nome)}</b> ${esc(eur(p.preco))}${p.colheita?' ('+esc(p.colheita)+')':''}`).join(' · ')}. Não se copiam: o vinho lê-os do Catálogo, sempre atualizados.</span>`);
    }else if(c.estado==='ligado')out.push('Este vinho já existe no Catálogo.');
    else if(c.estado==='nada')out.push(P.naCat?'Não há no Catálogo nenhum vinho parecido: é mesmo novo.':'O vinho não existe no Catálogo.');
    else if(c.estado==='recusado')out.push(P.naCat?'Nenhum dos parecidos é este: é um vinho novo.':'Nenhum dos vinhos do Catálogo é este.');
    else if(c.estado==='cor')out.push(`O Catálogo tem um <b>${esc(c.nome)}</b>, mas ${esc(c.cor.toLowerCase())} — deve ser outro vinho, não trouxe nada.`);
    else if(c.estado==='erro')out.push(`Não consegui perguntar ao Catálogo (${esc(c.msg)}).`);
  }
  // A IA, como na WineCatalog (`wcRevisaoCorpo`): o que fez numa frase, e os
  // avisos em caixa; as fontes e os sites vão para o fim, depois da lista.
  const f=P.ultima==='ia'?P.et.ia:null;
  let caixas='';
  if(f&&f.estado==='feito'){
    const quem=f.soSites?'A leitura dos sites escolhidos':'A pesquisa com IA';
    const n=pqLinhasIA(P).length;
    out.push(`${quem} terminou e ${n?`trouxe informação nova em ${pqQtd(n,'campo','campos')}.`:'não trouxe nada de novo.'}`);
    if(f.aviso)caixas+=`<div class="rv-aviso">⚠️ ${esc(f.aviso)}</div>`;
    if(f.semFonte&&f.semFonte.length)caixas+=`<div class="rv-aviso">${f.semFonte.length===1?'1 campo veio':f.semFonte.length+' campos vieram'} sem a IA dizer de que página o tirou (${esc(f.semFonte.map(pqRot).join(', '))}) — pode não ser dos sites escolhidos. Mostra-se para comparares; onde já havia valor, não vem marcado.</div>`;
    if(f.memoria)caixas+='<div class="rv-aviso">🧠 A IA respondeu <b>de memória</b>, sem pesquisar na net — confere antes de guardar.</div>';
  }
  return out.map(t=>`<p>${t}</p>`).join('')+caixas;
}
/* Depois da lista: as fontes, o que se fez com cada site, e numa linha em
   itálico de onde saiu tudo isto (a mesma frase da WineCatalog). */
function pqRodapeHTML(P){
  const f=P.ultima==='ia'?P.et.ia:null;
  if(!f||f.estado!=='feito')return '';
  const fim=f.pesquisaWeb===false?'⚠️ Isto saiu da memória do modelo, sem pesquisa na net — confere tudo antes de aceitar.'
    :f.soSites?'Lido só das páginas e dos resultados dos sites escolhidos — confere antes de aceitar.'
    :f.pesquisaWeb===true?'Pesquisado no Google. Leitura automática de páginas da net — vale como ponto de partida, não como certeza.'
    :'';
  return pqFontesHTML(f.fontes)+pqSitesHTML(f)
    +(fim||f.modelo?`<div class="ia-fontes"><i>${esc(fim)}${f.modelo?`${fim?' · ':''}${esc(f.modelo)}`:''}</i></div>`:'');
}
function pqCamposHTML(P){
  const ks=pqChavesIA(P);
  const falta=k=>pqVazio(P.atual[k])&&!P.hist[k]&&!P.preenchidos[k];
  const marcados=ks.filter(falta);
  const n=marcados.length;
  return `<details class="pq-campos"><summary>O que pedir: ${n?`${n} ${n===1?'campo':'campos'} (os que faltam)`:'nenhum — já não falta nada; escolhe o que queres confirmar'}</summary>
    <div class="ia-escs">${ks.map(k=>`<label class="ia-esc">
      <input type="checkbox" class="pq-campo" value="${esc(k)}"${marcados.includes(k)?' checked':''}>
      <span>${esc(pqRot(k))}${pqVazio(P.atual[k])?'':'<i>já tem</i>'}${P.hist[k]||P.preenchidos[k]?'<i>já encontrado</i>':''}</span></label>`).join('')}</div>
    <label class="ia-esc" style="margin-top:6px"><input type="checkbox" id="pq-colheita"${P.colheitaEsp?' checked':''}>
      <span>Tem de ser exatamente a colheita de ${esc(String(P.id.ano||'este ano'))}<i>para o teor, o estágio, o preço e as notas de prova — a nota do Vivino vem sempre às duas (a da colheita e a de todas)</i></span></label>
  </details>`;
}
/* ── PROCURAR LINKS (29/09/2026, o dono das apps) ──
   "Dar um link à IA e dizer 'lê só isto'" é o que traz a informação mais
   fidedigna. Este passo só encontra os links: UMA pesquisa Serper (na
   `vinho-info`, `links:true`, só no pacote completo), e a lista mostra os
   resultados — o título abre a página noutro separador, para se ver se é
   o vinho. Nenhum vem marcado; escolhem-se até `P.linksMax` (2), e seguem
   pelo "só estes sites" de sempre. Para outros, volta-se aqui depois. O
   Vivino não entra na lista (não se deixa abrir): o link e as estrelas que
   o Google mostra vão com a pesquisa (`vivinoGoogle`). Ao lado de cada
   site, como se tem portado (`paginas_por_site`, migração 30).
   Por passos (29/09/2026): a 1.ª lista vem só das lojas (GN, Granvine,
   Vinha.pt, Portugal Vineyards, Wine Radar); "Mais links" acrescenta a
   pesquisa geral, página a página (`P.linksProx`, que a função devolve).
   Cada passo é UMA pesquisa Serper; o que já se marcou fica marcado. */
async function pqLinks(mais){
  const P=PQ;if(!P)return;
  if(!temPremium()){toast('Procurar links é do pacote completo',1);return;}
  if(mais&&(!P.links||!P.linksProx))return;
  pqLerCaixas();
  const pedido={links:true,nome:P.id.nome};
  if(mais){
    pedido.fase=P.linksProx.fase;pedido.pagina=P.linksProx.pagina;
    pedido.excluir=P.links.map(l=>l.url);
  }
  if(P.id.ano)pedido.ano=P.id.ano;
  const prod=P.id.produtor||(P.novo?document.getElementById('e-produtor')?.value.trim():'')||'';
  if(prod)pedido.produtor=prod;
  P.corre=mais?'links+':'links';pqPintar();
  let d={},ok=false;
  try{
    const r=await sbFetch(`${SB_URL}/functions/v1/vinho-info`,{method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},body:JSON.stringify(pedido)});
    try{d=await r.json();}catch(_){}
    ok=r.ok;
    if(!ok&&!d.error)d.error='o servidor respondeu HTTP '+r.status;
  }catch(e){d={error:'não foi possível falar com o servidor. Sem rede?'};}
  if(PQ!==P)return;
  P.corre='';
  if(!ok){toast('Procurar links: '+d.error,1);pqPintar();return;}
  const novos=Array.isArray(d.links)?d.links:[];
  const viv=d.vivino&&typeof d.vivino==='object'?d.vivino:null;
  P.linksProx=d.proximo&&typeof d.proximo==='object'?d.proximo:null;
  P.linksMax=Number(d.escolher)||2;
  if(mais){
    P.links=P.links.concat(novos);
    P.linksVivino=P.linksVivino||viv;
    if(!novos.length)toast('Não vieram links novos'+(P.linksProx?' — podes tentar a página seguinte':''),1);
  }else{
    P.links=novos;P.linksVivino=viv;P.linksMarca=[];
    if(!novos.length)toast('A pesquisa não trouxe links que se possam abrir',1);
  }
  P.linksVer=true;
  pqPintar();
  if(mais&&novos.length){
    const el=document.querySelector('.pq-links .pq-grupo:last-of-type');
    if(el)el.scrollIntoView({block:'start',behavior:'smooth'});
  }
}
function pqLinksMarcados(P){return (P.linksMarca||[]).map(i=>P.links[i]&&P.links[i].url).filter(Boolean);}
function pqLinkMarcar(el,i){
  const P=PQ;if(!P||!P.links)return;
  const m=P.linksMarca||(P.linksMarca=[]);
  if(el.checked){
    if(m.length>=P.linksMax){el.checked=false;toast(`Escolhe no máximo ${P.linksMax} — para outros, pesquisa outra vez a seguir`);return;}
    if(!m.includes(i))m.push(i);
  }else P.linksMarca=m.filter(x=>x!==i);
  pqLinksContar();
}
// Quantas páginas vão: as marcadas na lista e as coladas por baixo dela.
function pqLinksN(P,colados){return new Set([...pqLinksMarcados(P),...colados]).size;}
function pqLinksContar(){
  const P=PQ,b=document.getElementById('pq-links-ir');if(!P||!b)return;
  b.textContent=`🔎 Pesquisar só nestes (${pqLinksN(P,pqColados(document.getElementById('pq-sites')?.value))})`;
}
// O título de cada leva de links: de onde vieram.
function pqLinksGrupo(l){
  return l.grupo==='lojas'?'Nas lojas (Garrafeira Nacional, Granvine, Vinha.pt, Portugal Vineyards, Wine Radar)'
    :l.grupo==='web'?`Na internet${Number(l.pagina)>1?' · página '+l.pagina:''}`:'';
}
function pqLinksHTML(P){
  const L=P.links;
  let grupo=null;
  const lista=L.length?L.map((l,i)=>{
    const g=pqLinksGrupo(l);
    const cab=g&&g!==grupo?`<div class="pq-grupo">${esc(g)}</div>`:'';
    grupo=g||grupo;
    const h=l.historico;
    const marcas=[];
    if(l.outroAno)marcas.push(`parece ser da colheita ${esc(String(l.outroAno))}`);
    if(h&&h.tentativas){
      if(!h.lidas&&h.tentativas>=3)marcas.push(`<b>este site não deixou ler ${h.tentativas} de ${h.tentativas} vezes</b>`);
      else marcas.push(`site lido ${h.lidas} de ${h.tentativas} ${h.tentativas===1?'vez':'vezes'}`);
    }
    return `${cab}<label class="ia-esc pq-link"><input type="checkbox"${(P.linksMarca||[]).includes(i)?' checked':''} onchange="pqLinkMarcar(this,${i})">
      <span><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.titulo||l.url)}</a>
      <i>${esc(l.site)}${l.snippet?' — '+esc(l.snippet):''}</i>${marcas.length?`<i class="pq-link-m">${marcas.join(' · ')}</i>`:''}</span></label>`;
  }).join(''):'<p class="note">Não veio nenhum link que se possa abrir.</p>';
  const px=P.linksProx;
  const mais=px?`<button class="btn ghost pq-mais" onclick="pqLinks(true)">➕ ${px.fase==='web'&&px.pagina===1?'Mais links (na internet)':'Mais 5 links'}</button>`:'';
  const viv=P.linksVivino?`<p class="note">🍷 O Vivino não se deixa abrir, mas o link e a nota que o Google mostra
    (<a href="${esc(P.linksVivino.url)}" target="_blank" rel="noopener">${esc(P.linksVivino.titulo||'Vivino')}</a>) vão com a pesquisa.</p>`:'';
  return `<p class="pq-q">Que páginas são deste vinho?</p>
    <p class="note">Abre os links para confirmar e marca até ${P.linksMax}. A IA lê só essas páginas; para outras, voltas aqui a seguir.</p>
    <div class="pq-links">${lista}</div>${mais}${viv}
    <label for="pq-sites">Ou cola o link de uma página que já tenhas</label>
    <textarea id="pq-sites" rows="2" oninput="pqLinksContar()" placeholder="https://…">${esc(P.sites.join('\n'))}</textarea>
    ${pqCamposHTML(P)}${pqOpcoesHTML(P)}
    <div class="macoes"><button class="btn prim" id="pq-links-ir" onclick="pqIA()">🔎 Pesquisar (${pqLinksN(P,P.sites)})</button>
      <button class="btn ghost" onclick="pqLinksVer(false)">‹ Voltar</button>${pqFecharJunto(P)}</div>`;
}
// As notas para identificar o vinho: raramente fazem falta, ficam fechadas.
function pqOpcoesHTML(P){
  return `<details class="pq-campos"${P.notas?' open':''}><summary>Mais opções</summary>
    <label for="pq-notas">Notas para identificar o vinho</label>
    <textarea id="pq-notas" rows="2" maxlength="300" placeholder="ex.: edição limitada, da casa Ferreirinha">${esc(P.notas)}</textarea>
  </details>`;
}
/* Passo 1: como se procura (ver `pqTipo`). */
function pqTipoHTML(P,aMao){
  const c=P.et.cat;
  const prem=temPremium();
  return `<p class="pq-q">${c&&c.estado==='feito'?'Como queres procurar o resto?':'Como queres procurar?'}</p>
    <div class="pq-tipos">
      <button class="pq-tipo" onclick="pqTipo('sites')"><b>🔗 Em sites concretos</b>
        <span>${prem?'Colas o link de 1 ou 2 páginas que já tenhas copiado, ou a app sugere-te alguns sites.'
          :'Colas o link de 1 ou 2 páginas que já tenhas copiado.'}</span></button>
      <button class="pq-tipo" onclick="pqTipo('ia')"><b>✨ Perguntar à IA</b>
        <span>${prem?'Pesquisa no Google e no Vivino, e a IA lê o que encontrar.'
          :'A IA pesquisa no Google. Às vezes responde de memória, e diz-to.'}</span></button>
    </div>
    ${aMao?`<div class="macoes">${aMao}</div>`:''}`;
}
/* A pergunta da etapa em que se está, com os botões dela. */
function pqPerguntaHTML(P){
  if(P.corre){
    const t=P.corre==='cat'?(P.naCat?'A procurar vinhos parecidos no Catálogo…':'A ver o que o Catálogo já sabe…'):P.corre==='links'?'A procurar links nas lojas…':P.corre==='links+'?'A procurar mais links…':'A pesquisar com IA. Pode levar até dois minutos.';
    return `<div class="pq-espera"><div class="gl-spin"></div><div>${t}${P.corre==='ia'
      ?'<div class="note">Podes fechar esta janela: a pesquisa continua, e ao voltares a “Procurar informação” está aqui à tua espera.</div>':''}</div></div>`;
  }
  if(P.escolher){
    const L=P.escolher;
    const q=P.naCat
      ?(L.length===1?'Antes de criar: no Catálogo há um vinho parecido. É o teu?':`Antes de criar: no Catálogo há ${L.length} vinhos parecidos. Algum é o teu?`)
      :(L.length===1?'Encontrei este vinho no Catálogo. É o teu?':`Encontrei ${L.length} vinhos no Catálogo. Qual é o teu?`);
    return `<p class="pq-q">${q}</p>
      <div class="pq-colheitas">${L.map((c,i)=>{
        const castas=Array.isArray(c.castas)?c.castas.join(', '):(c.castas||'');
        const igual=P.id.ano!=null&&c.ano===P.id.ano;
        return `<button class="pq-colh${igual?' igual':''}" onclick="pqColheitaEscolher(${i})"><b>${c.ano!=null?esc(String(c.ano)):'s/ ano'}</b>
          <span>${esc(c.nome)}${c.produtor?' · '+esc(c.produtor):''}</span>
          <i>${castas?esc(castas):'castas por saber'}${c.regiao?' · '+esc(c.regiao):''}${igual?' · a tua colheita':''}</i></button>`;}).join('')}</div>
      ${P.naCat?`<p class="note">Da tua colheita, abre-se o que já existe. De outra, crias a tua com os factos desse vinho.</p>`
        :P.id.ano!=null&&!L.some(c=>c.ano===P.id.ano)?`<p class="note">A tua colheita (${esc(String(P.id.ano))}) não está no Catálogo. Escolhendo outra, vêm só os factos do vinho (castas, região…), sem nota, preço nem imagem.</p>`:''}
      <div class="macoes"><button class="btn ghost" onclick="pqColheitaNenhum()">${P.naCat?'Nenhum destes: é um vinho novo':'Nenhum destes'}</button></div>`;
  }
  if(P.repetir){
    return `<div class="aviso">${P.repetir.minha?'Pesquisaste este vinho':'Este vinho foi pesquisado'} pela última vez em
      <b>${esc(dataHoraLocal(P.repetir.quando))}</b>. A ficha raramente muda de um mês para o outro. Pesquisar à mesma?</div>
      <div class="macoes"><button class="btn prim" onclick="pqIA(true)">Pesquisar à mesma</button>
        <button class="btn ghost" onclick="PQ.repetir=null;pqPintar()">Não</button></div>`;
  }
  if(P.fase!=='ia')return '';
  const aMao=P.novo
    ?`<button class="btn ghost" onclick="pqFimNovo()">Ir para o formulário</button>`
    :P.cat?''
    :`<button class="btn ghost" onclick="pqAMao()">✏️ Preencher à mão</button>`;
  if(!podeUsarIA())return `<div class="macoes">${aMao}</div>`;
  // Passo 1: como. Passo 2: o que (e onde, nos sites).
  if(!P.tipo)return pqTipoHTML(P,aMao);
  const e=P.et.ia;
  const falhou=e&&e.estado==='erro';
  const erro=falhou?`<div class="erro">A pesquisa não deu: ${esc(e.msg)}</div>`:'';
  const voltar=`<button class="btn ghost" onclick="pqTipoVoltar()">‹ Voltar</button>`;
  if(P.tipo==='sites'){
    if(P.links&&P.linksVer&&temPremium())return erro+pqLinksHTML(P);
    const nMarca=P.links?pqLinksMarcados(P).length:0;
    return `${erro}<p class="pq-q">🔗 Em sites concretos</p>
      <label for="pq-sites">O link da página do vinho</label>
      <textarea id="pq-sites" rows="2" placeholder="ex.: o link da página do vinho numa loja">${esc(P.sites.join('\n'))}</textarea>
      ${!temPremium()?'':P.links
        ?`<div class="pq-links-bt"><button class="btn ghost" onclick="pqLinksVer(true)">💡 Ver os sites sugeridos${nMarca?` (${nMarca} ${nMarca===1?'marcado':'marcados'})`:''}</button></div>`
        :`<div class="pq-links-bt"><button class="btn ghost" onclick="pqLinks()">💡 Sugere-me sites</button></div>`}
      ${pqCamposHTML(P)}${pqOpcoesHTML(P)}
      <div class="macoes"><button class="btn prim" onclick="pqIA()">🔎 ${falhou?'Tentar de novo':'Pesquisar'}</button>${voltar}${pqFecharJunto(P)}</div>`;
  }
  return `${erro}<p class="pq-q">✨ Perguntar à IA</p>
    ${pqCamposHTML(P)}${pqOpcoesHTML(P)}
    <div class="macoes"><button class="btn prim" onclick="pqIA()">🔎 ${falhou?'Tentar de novo':'Pesquisar'}</button>${voltar}${pqFecharJunto(P)}</div>`;
}
function pqDefeito(P,k){
  if(P.esc[k])return P.esc[k];
  if(!pqVazio(P.atual[k]))return 'atual';
  // No vinho novo só se revê o que a IA trouxe: o catálogo já foi para o
  // formulário quando se escolheu o vinho dele.
  if(P.novo)return 'ia';
  return PQ_FORCA.find(f=>f in P.hist[k])||'atual';
}
/* Os campos em que a IA trouxe alguma coisa (diferente do que está). */
function pqLinhasIA(P){return pqChaves(P).filter(k=>P.hist[k]&&'ia' in P.hist[k]);}

/* O QUE SE ENCONTROU — o ecrã da WineCatalog (29/09/2026, o dono das apps:
   "fica mais claro o que encontrou, onde encontrou, com links"). Uma linha
   por campo: o nome, o que está agora (riscado) → o que se encontrou, e por
   baixo DE ONDE veio (a página que a IA diz ter lido, o link colado, a
   pesquisa Google, o Catálogo). A linha inteira é o <label>: toca-se em
   qualquer sítio para marcar, e um link lá dentro abre-se sem mexer na
   caixa. Vêm marcados os campos vazios; trocar o que lá está é um clique
   consciente. Quando o Catálogo e a IA trazem valores DIFERENTES para o
   mesmo campo, são duas linhas e só uma pode ficar marcada (`pqMarcar`).
   No vinho novo, só as da IA: o Catálogo já está no formulário. */
function pqValorHTML(k,v){
  if(pqVazio(v))return '<em class="rv-vazio">vazio</em>';
  if(Array.isArray(v))return esc(v.join(', '));
  if(typeof v==='object')return esc(JSON.stringify(v));
  const s=String(v);
  if(/^https?:\/\/\S+$/i.test(s)){
    const img=k==='imagem_url'?`<img class="rv-img" src="${esc(s)}" alt="" onerror="this.remove()">`:'';
    return img+escLink(s);
  }
  if(k==='preco_medio')return esc(eur(v));
  if(k==='teor')return esc(s)+' %';
  return esc(s);
}
function pqFonteHTML(k,f,P){
  if(f==='cat')return '<span class="rv-de">↳ do Catálogo</span>';
  const ia=P.et.ia||{};
  const o=ia.origem&&ia.origem[k];
  if(o&&typeof o==='object'){
    if(o.google)return '<span class="rv-de">↳ da pesquisa Google <i>(a IA não diz a página)</i></span>';
    if(o.url){
      const lnk=`<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.site||o.url)}</a>`;
      if(o.dada&&!o.pagina)return `<span class="rv-de">↳ do link que colaste · ${lnk}</span>`;
      return `<span class="rv-de">↳ de ${lnk} <i>${o.pagina?'· página lida':'· resumo no Google'}</i></span>`;
    }
  }
  // O que a vinho-info respondeu do catálogo do lado dela (uma pesquisa
  // anterior) não tem página — diz-se isso, e não se inventa uma.
  if(Array.isArray(ia.catalogoCampos)&&ia.catalogoCampos.includes(k))
    return '<span class="rv-de">↳ do Catálogo <i>· de uma pesquisa anterior</i></span>';
  if(ia.soSites&&Array.isArray(ia.semFonte)&&ia.semFonte.includes(k))
    return '<span class="rv-de">↳ da IA <i>(sem dizer de que página — pode não ser dos sites escolhidos)</i></span>';
  return '<span class="rv-de">↳ da IA <i>(sem dizer de onde)</i></span>';
}
function pqLinhasHTML(P){
  const ks=P.novo?pqLinhasIA(P):pqChaves(P).filter(k=>P.hist[k]);
  return ks.map(k=>{
    const h=P.hist[k], def=pqDefeito(P,k), agora=P.atual[k];
    // As fontes que trouxeram o MESMO valor são uma linha só.
    const grupos=[];
    (P.novo?['ia']:PQ_FORCA.filter(f=>f in h)).forEach(f=>{
      const t=pqTxt(h[f]);
      const g=grupos.find(x=>chave(x.t)===chave(t));
      g?g.fs.push(f):grupos.push({t,fs:[f]});
    });
    return grupos.map(g=>`<label class="rv-linha">
      <input type="checkbox" data-campo="${esc(k)}" value="${g.fs[0]}"${g.fs.includes(def)?' checked':''} onchange="pqMarcar(this)">
      <span class="rv-campo">
        <b>${esc(pqRot(k))}</b>
        ${pqVazio(agora)?'':`<span class="rv-antes">${pqValorHTML(k,agora)}</span><span class="rv-seta">→</span>`}<span class="rv-novo">${pqValorHTML(k,h[g.fs[0]])}</span>
        ${g.fs.map(f=>pqFonteHTML(k,f,P)).join('')}
      </span>
    </label>`).join('');
  }).join('');
}
/* Marcar uma linha desmarca as outras do mesmo campo; desmarcar deixa o de agora. */
function pqMarcar(el){
  const P=PQ;if(!P)return;
  const k=el.dataset.campo;
  if(el.checked){
    document.querySelectorAll('#modal-ia-in .rv-linha input').forEach(x=>{if(x!==el&&x.dataset.campo===k)x.checked=false;});
    P.esc[k]=el.value;
  }else P.esc[k]='atual';
  pqContar();
}
function pqEscolhas(P){
  return (P.novo?pqLinhasIA(P):pqChaves(P).filter(k=>P.hist[k])).map(k=>({k,fonte:pqDefeito(P,k)}))
    .filter(e=>e.fonte!=='atual'&&e.fonte in P.hist[e.k]).map(e=>({...e,val:P.hist[e.k][e.fonte]}));
}
function pqMarcarTudo(){
  const P=PQ;if(!P)return;
  // Uma linha por campo: onde há duas propostas, fica a que já estava marcada
  // (ou a primeira).
  const vistos=new Set();
  document.querySelectorAll('#modal-ia-in .rv-linha input:checked').forEach(x=>vistos.add(x.dataset.campo));
  document.querySelectorAll('#modal-ia-in .rv-linha input').forEach(x=>{
    if(vistos.has(x.dataset.campo))return;
    x.checked=true;vistos.add(x.dataset.campo);P.esc[x.dataset.campo]=x.value;
  });
  pqContar();
}
function pqContar(){
  const P=PQ,b=document.getElementById('pq-guardar');
  if(!P||!b)return;
  if(P.novo){
    const n=pqEscolhas(P).length;
    b.disabled=!!P.corre;
    b.textContent=pqNovoGrava(P)?pqNovoRotulo():'Ir para o formulário';
    const r=document.getElementById('pq-rever');
    if(r){r.disabled=!!P.corre;r.style.display=pqNovoGrava(P)?'':'none';}
    return;
  }
  // A colheita escolhida (num vinho gravado sem ano) também é um campo a gravar.
  const n=pqEscolhas(P).length+(P.anoEscolhido?1:0);
  b.disabled=!n||!!P.corre;
  b.textContent=n?`Guardar ${n} ${n===1?'campo':'campos'}`:'Nada escolhido';
}
// Com nada para rever, o "Fechar" vai na linha dos botões da pergunta (o
// dono, 30/09/2026: "cabem os 3 botões na mesma linha") em vez de ficar
// sozinho por baixo.
function pqFecharJunto(P){
  if(!P._fecharJunto)return '';
  P._fecharPosto=true;
  return `<button class="btn ghost" onclick="fecharModal('modal-ia')">Fechar</button>`;
}
function pqPintar(){
  const P=PQ;if(!P)return;
  const box=document.getElementById('modal-ia-in');
  const linhas=P.novo&&P.fase!=='fim'?'':pqLinhasHTML(P);
  const iguais=[...P.iguais].filter(k=>!P.hist[k]||(P.novo&&!('ia' in P.hist[k])));
  const revNovo=P.novo&&P.fase==='fim'&&!P.corre;
  const podeGuardar=revNovo||(!P.novo&&(linhas||P.anoEscolhido));
  P._fecharJunto=!podeGuardar&&!linhas;P._fecharPosto=false;
  const conversa=pqRelatoHTML(P)+pqPerguntaHTML(P);
  box.innerHTML=`
    <div class="mtop"><div><h3>🔎 Procurar informação</h3>
      <div class="note" style="margin-top:3px">${esc(P.id.nome)} ${P.id.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    ${P.cat?'':`<div class="pq-passos">${(podeUsarIA()&&!P.soVer?['cat','ia']:['cat']).map(k=>pqPassoHTML(k,P)).join('<span class="pq-seta">›</span>')}</div>`}
    <div class="pq-conversa">${conversa}</div>
    ${linhas?`<p class="note rv-intro"><b>${P.novo?'Ainda não está no formulário.':'Ainda não foi gravado nada.'}</b>
        Só ${P.novo?'passa':'entra'} o que ficar marcado${P.cat?', e muda o vinho no Catálogo para toda a gente':''}. Já vêm marcados os campos que estavam <b>vazios</b>;
        para trocar o que já lá estava, marca à mão.</p>
      <div class="rv-lista">${linhas}</div>`:''}
    ${iguais.length&&!(P.novo&&P.fase!=='fim')?`<div class="note" style="margin-top:8px">${linhas?'Mais ':''}${iguais.length===1?'1 campo veio':iguais.length+' campos vieram'} igual ao que já está (${esc(iguais.map(pqRot).join(', '))}).</div>`:''}
    ${P._fecharPosto?'':`<div class="macoes pq-fim">
      ${podeGuardar?`<button class="btn prim" id="pq-guardar" onclick="${revNovo?'pqPassarForm()':'pqGuardar()'}"></button>`:''}
      ${podeGuardar&&revNovo?'<button class="btn ghost" id="pq-rever" onclick="pqPassarForm(true)">✏️ Rever antes de gravar</button>':''}
      ${linhas?'<button class="btn ghost" onclick="pqMarcarTudo()">Marcar tudo</button>':''}
      ${P.fase==='fim'&&!P.corre&&podeUsarIA()?'<button class="btn ghost" onclick="pqOutraPesquisa()">‹ Pesquisar de outra forma</button>':''}
      <button class="btn ghost" onclick="fecharModal('modal-ia')">Fechar</button>
    </div>`}
    ${pqRodapeHTML(P)}`;
  pqContar();
}

/* ── Guardar (vinho já gravado) ── */
async function pqGuardar(){
  const P=PQ;if(!P||P.novo)return false;
  if(P.cat)return pqGuardarCat();
  const escs=pqEscolhas(P);
  if(!escs.length&&!P.anoEscolhido){toast('Não escolheste nada');return false;}
  if(roGuard())return false;
  const v=IDXV[P.vid];if(!v)return false;
  // Tudo por PATCH, o catálogo incluído: o valor gravado é o que se viu no
  // ecrã. A `aplicar_do_catalogo` voltava a procurar a linha pelo nome do
  // vinho, e o nome pode ser justamente o que não casa ("… Reserva Tinto")
  // ou casar com outra colheita da que se escolheu.
  const outros=escs.filter(e=>e.fonte!=='cat');
  const patch={};let castas=null;
  escs.forEach(e=>{
    if(e.k==='castas'){castas=Array.isArray(e.val)?e.val:String(e.val).split(',').map(s=>s.trim()).filter(Boolean);return;}
    patch[e.k]=e.val;
  });
  if(P.anoEscolhido&&!v.ano)patch.ano=P.anoEscolhido;
  if(!(patch.ano||v.ano))IA_JANELA.forEach(k=>delete patch[k]);
  if(outros.length){
    // O carimbo da procura: de onde veio, para daqui a um ano se saber.
    const r=P.res.ia;
    patch.ai_atualizado_em=new Date().toISOString();
    if(r&&r.modelo)patch.ai_modelo=r.modelo;
    if(r&&Array.isArray(r.fontes)&&r.fontes.length)patch.ai_fontes=r.fontes.slice(0,8);
  }
  const b=document.getElementById('pq-guardar');
  if(b){b.disabled=true;b.textContent='A guardar…';}
  try{
    if(Object.keys(patch).length){
      const r=await sbReq('PATCH',`vinhos?id=eq.${P.vid}`,patch,{'Prefer':'return=representation'});
      Object.assign(v,patch,(r&&r[0])||{});
    }
    if(castas){
      await sbRpc('definir_castas',{p_vinho_id:P.vid,p_nomes:castas});
      v.castas=castas.slice().sort((a,b)=>a.localeCompare(b,'pt'));
      await recarregarCastas();
    }
    PQ=null;
    fecharModal('modal-ia');
    renderLista();refrescarVinhoAberto();
    catComparar(P.vid,true);
    const nG=escs.length+(patch.ano?1:0);
    toast(`${nG} ${nG===1?'campo guardado':'campos guardados'} ✓`);
    return true;
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    pqContar();
    return false;
  }
}
/* Guardar num vinho do CATÁLOGO: a linha corrige-se pela `winecatalog.editar`
   (a origem é a do curador ou a do admin, que a `editar` escolhe). O
   PRODUTOR é identidade: vai à parte, depois do resto, com o interruptor da
   identidade — se a linha passar a ser a mesma que outra, a `editar` recusa
   e diz qual (vai-se aos Duplicados da WineCatalog), e o resto já ficou. */
async function pqGuardarCat(){
  const P=PQ;if(!P||!P.cat)return false;
  const escs=pqEscolhas(P);
  if(!escs.length){toast('Não escolheste nada');return false;}
  const v=IDXV[P.vid];if(!v)return false;
  const campos={};let produtor=null;
  escs.forEach(e=>{
    if(e.k==='produtor'){produtor=String(e.val||'').trim();return;}
    if(e.k==='castas'){
      campos.castas=(Array.isArray(e.val)?e.val:String(e.val).split(',')).map(s=>String(s).trim()).filter(Boolean)
        .sort((a,b)=>a.localeCompare(b,'pt'));
      return;
    }
    campos[e.k]=e.val;
  });
  if(!v.ano)IA_JANELA.forEach(k=>delete campos[k]);
  const WC={'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'};
  const b=document.getElementById('pq-guardar');
  if(b){b.disabled=true;b.textContent='A guardar…';}
  let n=0,erroIdt='';
  try{
    if(Object.keys(campos).length){
      const r=await sbReq('POST','rpc/editar',{p_id:P.cat,p_campos:campos},WC);
      n+=(r&&Number(r.campos))||0;
    }
  }catch(e){
    toast('Não foi possível guardar: '+e.message,1);
    pqContar();
    return false;
  }
  if(produtor){
    try{
      await sbReq('POST','rpc/editar',{p_id:P.cat,p_campos:{},p_nome:v.nome,p_produtor:produtor,
        p_ano:v.ano??null,p_mexer_identidade:true},WC);
      n++;
    }catch(e){erroIdt=e.message;}
  }
  PQ=null;
  fecharModal('modal-ia');
  CAT_VINHOS=null;
  try{await catCarregar();}catch(e){}
  renderLista();refrescarVinhoAberto();
  if(erroIdt)toast('O produtor não mudou: '+erroIdt,1);
  else toast(n?`Corrigido no catálogo: ${n} ${n===1?'campo':'campos'} ✓`:'Nada mudou no catálogo');
  return true;
}
/* No vinho novo: o que uma fonte trouxe vai direto para os campos VAZIOS do
   formulário (o que a pessoa escreveu nunca se toca). O formulário é a
   confirmação — abre-se no fim, já cheio, para rever e gravar. */
function pqPorNoForm(P,fonte){
  const res={};
  pqChaves(P).forEach(k=>{
    const h=P.hist[k];
    if(!h||!(fonte in h)||P.preenchidos[k])return;
    const id=PQ_FORM[k], el=id&&document.getElementById(id);
    if(el&&el.value.trim())return;             // o que a pessoa escreveu fica
    res[k]=h[fonte];P.preenchidos[k]=fonte;
  });
  if(fonte==='cat')res.modelo='catálogo partilhado';
  else if(P.res[fonte]){res.modelo=P.res[fonte].modelo||'';res.fontes=P.res[fonte].fontes||[];}
  iaPreencherForm(res,false);
}
/* No vinho novo, depois da revisão: o que ficou marcado vai para o
   formulário — por cima do que lá estava, se foi marcado à mão — e o vinho
   GRAVA-SE logo (30/09/2026, o dono: "prefiro que guarde logo e, se o user
   quiser, depois abre o vinho em edição" — como na WineCatalog). Abre-se a
   página do vinho, onde está o Editar. "Rever antes de gravar" (`rever`)
   abre o formulário inteiro, como era. */
function pqPassarForm(rever){
  const P=PQ;if(!P||!P.novo)return;
  const escs=pqEscolhas(P);
  if(escs.length){
    const res={}, antes={};
    escs.forEach(e=>{
      res[e.k]=e.val;
      const id=PQ_FORM[e.k], el=id&&document.getElementById(id);
      if(el){antes[id]=el.value;el.value='';}
      P.preenchidos[e.k]='ia';
    });
    if(P.res.ia){res.modelo=P.res.ia.modelo||'';res.fontes=P.res.ia.fontes||[];}
    iaPreencherForm(res,false);
    // Um valor que o campo não aceita (uma opção que a lista não tem) não
    // deixa o campo vazio: volta o que lá estava.
    Object.entries(antes).forEach(([id,v])=>{const el=document.getElementById(id);if(el&&!el.value)el.value=v;});
  }
  if(!rever&&pqNovoGrava(P))pqGravarNovo();
  else pqFimNovo();
}
// Há alguma coisa da procura para gravar (o marcado, ou o que o Catálogo
// já pôs no formulário)? Sem nada, o botão continua a ir para o formulário.
function pqNovoGrava(P){return pqEscolhas(P).length>0||Object.keys(P.preenchidos).length>0;}
function pqNovoRotulo(){
  return FORM_MODO==='catalogo'?'Criar no catálogo':FORM_MODO==='desejo'?'Adicionar à wishlist':'Adicionar à garrafeira';
}
async function pqGravarNovo(){
  const b=document.getElementById('pq-guardar');
  if(b){b.disabled=true;b.textContent='A guardar…';}
  const modo=FORM_MODO;
  // O resto do formulário continua escondido, e o `guardarVinho` lê-o na
  // mesma: a primeira garrafa fica com os valores de omissão (uma, sem
  // lugar — por arrumar), e arruma-se depois.
  const id=await guardarVinho(0,modo);
  if(document.getElementById('modal-edit').classList.contains('on')){
    // Não gravou (falta alguma coisa, ou a rede): o formulário diz o quê.
    pqFimNovo();
    return;
  }
  PQ=null;
  fecharModal('modal-ia');
  if(modo!=='catalogo'&&id&&IDXV[id])verVinho(id);
}
function pqFimNovo(){
  const P=PQ;
  const n={};
  if(P)Object.values(P.preenchidos).forEach(f=>{n[f]=(n[f]||0)+1;});
  const tot=Object.values(n).reduce((a,b)=>a+b,0);
  const por=Object.entries(n).map(([f,q])=>`${PQ_NOMES[f]} ${q}`).join(' · ');
  // No vinho novo o formulário é a revisão: é aqui que se diz de que site
  // veio cada campo que a IA lá pôs.
  const deOnde=P&&P.et.ia?pqDeOndeResumoHTML(P.et.ia,Object.keys(P.preenchidos).filter(k=>P.preenchidos[k]==='ia')):'';
  // "Preencher à mão" no Catálogo: só se viu se já existia.
  const c=P&&P.et.cat||{};
  const semNada=P&&P.soVer
    ?(c.estado==='erro'?`Não consegui ver o Catálogo (${esc(c.msg)}).`
      :c.estado==='recusado'?'Nenhum dos parecidos é este: é um vinho novo.'
      :'Não há no Catálogo nenhum vinho parecido: é mesmo novo.')
    :'A procura não preencheu nenhum campo — escreve à mão o que souberes.';
  const est=document.getElementById('e-ia-estado');
  if(est)est.innerHTML=tot
    ?`<div class="note" style="margin-top:8px;color:var(--vd)">✓ ${tot} ${tot===1?'campo preenchido':'campos preenchidos'} (${esc(por)}). Confere antes de gravar.</div>${deOnde}`
    :`<div class="note" style="margin-top:8px">${semNada}</div>`;
  PQ=null;
  fecharModal('modal-ia');
  formMostrarResto();
}
/* "Preencher à mão" num vinho gravado: o que já se escolheu não se perde —
   guarda-se — e abre-se o Editar. */
async function pqAMao(){
  const P=PQ;if(!P)return;
  const temEsc=pqEscolhas(P).length>0||!!P.anoEscolhido;
  if(temEsc&&!await pqGuardar())return;
  if(!temEsc){PQ=null;fecharModal('modal-ia');}
  abrirEditarVinho(P.vid);
}

/* ── O FORMULÁRIO COMPACTO DO VINHO NOVO ──
   Nome, ano, cor e (opcional) produtor, e duas saídas: Procurar informação
   ou Preencher à mão. O resto do formulário só aparece depois de uma delas
   (27/09/2026, o dono das apps): antes, os vinte campos vazios à vista eram
   um convite a escrever o que a procura ia trazer. */
function formMostrarResto(){
  const r=document.getElementById('e-resto');
  if(r)r.style.display='';
  const b=document.getElementById('e-botoes');
  if(b)b.style.display='none';
}

/* ── A RESPOSTA COLADA DE OUTRO ASSISTENTE (no Editar) ──
   Grátis e para toda a gente que edita: copia-se um prompt para o
   assistente que se preferir (Gemini, ChatGPT, Claude…) e cola-se a
   resposta. Vive aqui, ao lado de onde se escreve à mão, e preenche os
   campos VAZIOS do formulário que está aberto — o que já lá está fica, e
   diz-se quantos ficaram. O prompt e o parser continuam a ser o mesmo
   espelho do `vinho-info.ts` (`iaManualPrompt`/`iaManualNormalizar`). */
let FORM_MANUAL=null;
function formManualAbrir(){
  const nome=document.getElementById('e-nome')?.value.trim();
  if(!nome){toast('Escreve primeiro o nome do vinho',1);return;}
  const v={nome,ano:inteiro(document.getElementById('e-ano')?.value),
    produtor:document.getElementById('e-produtor')?.value.trim()||'',
    regiao:document.getElementById('e-regiao')?.value.trim()||'',
    tipo:document.getElementById('e-tipo')?.value||''};
  FORM_MANUAL={ano:v.ano};
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><div><h3>✍️ Outro assistente</h3>
      <div class="note" style="margin-top:3px">${esc(v.nome)} ${v.ano||''}</div></div>
      <button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    <div class="aviso">1. Copia o prompt. 2. Cola-o no assistente de IA que preferires (Gemini, ChatGPT, Claude…).
      3. Copia a resposta toda (o JSON) e cola-a aqui por baixo. Só entram os campos que estão vazios no formulário.</div>
    <textarea id="ia-manual-prompt" readonly rows="6" onclick="this.select()">${esc(iaManualPrompt(v,null,false,'',[]))}</textarea>
    <button class="btn ghost full" style="margin-top:8px" onclick="iaManualCopiar()">📋 Copiar prompt</button>
    <label style="margin-top:12px" for="ia-manual-resposta">Resposta</label>
    <textarea id="ia-manual-resposta" rows="7" placeholder="Cola aqui o JSON que o assistente devolveu…"></textarea>
    <div class="note" id="pq-manual-erro" style="margin-top:6px;color:var(--dg)"></div>
    <div class="macoes"><button class="btn prim" onclick="formManualLer()">Preencher o formulário</button>
      <button class="btn ghost" onclick="fecharModal('modal-ia')">Cancelar</button></div>`;
  abrirModal('modal-ia');
}
function formManualLer(){
  const erro=m=>{const el=document.getElementById('pq-manual-erro');if(el)el.textContent=m;};
  const raw=iaManualExtrairJson(document.getElementById('ia-manual-resposta').value);
  if(!raw)return erro('Não consegui ler isto como JSON. Confirma que colaste a resposta toda, incluindo as chavetas { }.');
  if(raw.encontrado===false)return erro('O assistente disse que não encontrou o vinho'+(raw.aviso?': '+raw.aviso:'.'));
  const ficha=iaManualNormalizar(raw,(FORM_MANUAL&&FORM_MANUAL.ano)||null,null);
  if(!ficha)return erro('O JSON leu-se, mas não trouxe nenhum campo válido — confere se respeitou o formato pedido.');
  ficha.modelo=IA_MANUAL_MARCA;
  // Quantos campos tinham valor e ficaram como estavam: diz-se.
  let ficaram=0,entraram=0;
  Object.entries(PQ_FORM).forEach(([k,id])=>{
    const el=document.getElementById(id);
    if(!el||pqVazio(ficha[k]))return;
    if(el.value.trim())ficaram++;else entraram++;
  });
  iaPreencherForm(ficha,false);
  fecharModal('modal-ia');
  formMostrarResto();
  const est=document.getElementById('e-ia-estado');
  const msg=`✓ ${entraram} ${entraram===1?'campo preenchido':'campos preenchidos'} pela resposta colada${ficaram?` · ${ficaram} já tinha${ficaram===1?'':'m'} valor e ficou${ficaram===1?'':'ram'} como estava${ficaram===1?'':'m'}`:''}. Confere antes de gravar.`;
  if(est)est.innerHTML=`<div class="note" style="margin-top:8px;color:var(--vd)">${esc(msg)}</div>`;
  else toast(msg);
}

// Nome do campo no JSON que se pede ao Gemini — a mesma tabela do `CAMPOS`
// em vinho-info.ts, é o que liga as chaves da app ao texto do prompt.
const IA_CAMPOS_JSON={
  produtor:'produtor',ano:'ano',tipo:'tipo',estilo:'estilo',regiao:'regiao',
  sub_regiao:'subRegiao',mencao:'mencao',classificacao:'classificacao',
  castas:'castas',teor:'teor',estagio_meses:'estagioMeses',
  estagio_texto:'estagioTexto',vivino_nota:'vivinoNota',
  vivino_avaliacoes:'vivinoAvaliacoes',vivino_nota_global:'vivinoNotaGlobal',
  vivino_avaliacoes_global:'vivinoAvaliacoesGlobal',vivino_url:'vivinoUrl',
  imagem_url:'imagemUrl',preco_medio:'precoMedio',beber_de:'beberDe',
  beber_ate:'beberAte',notas_prova:'notasProva',harmonizacao:'harmonizacao',
  ai_resumo:'resumo'
};

/* Espelho da regra do Vivino de `vinho-info.ts` (`regraVivino`) — ver o
   comentário grande lá. A página é do VINHO; as NOTAS são duas (a de todas
   as colheitas e a de uma). `ano` undefined é o LOTE, onde cada vinho traz
   (ou não) o seu ano na lista. */
function iaManualRegraVivino(ano){
  const col=ano===undefined
    ?'"vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita indicada na lista (a página com "?year=<ano>", ou a dessa colheita na lista de colheitas); um vinho SEM ano na lista não as tem, fica só com a de todas. Se só vires a de todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.'
    :ano
    ?`"vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita ${ano}: a da página com "?year=${ano}", ou a dessa colheita na lista de colheitas. Se só vires a de todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.`
    :'"vivinoNota"/"vivinoAvaliacoes" ficam de fora: este vinho não tem colheita, e a única nota que serve é a de todas as colheitas.';
  return 'O Vivino tem DUAS notas, e não se misturam: "vivinoNotaGlobal"/"vivinoAvaliacoesGlobal" — a de TODAS as colheitas: a que a página do vinho mostra sem ano escolhido (…/w/<nº>, sem "?year="); '+col+' A nota é o número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm logo a seguir, entre parêntesis — não uses números de outra zona da página. Uma colheita nunca tem mais avaliações do que o vinho todo. "vivinoUrl" é a página do VINHO (…/<nome>/w/<nº>), a mesma para todas as colheitas: o ano não faz parte da identidade dela — basta o nome e o produtor baterem certo. Mantém o link se tiveres a certeza da página, mesmo sem nota.';
}
/* "Tem de ser exatamente a colheita X" — espelho da `regraColheita`. */
function iaManualRegraColheita(ano){
  return `O que responderes tem de ser da colheita ${ano}: teor, estágio, preço, notas de prova e janela de uma colheita diferente ficam fora do JSON.`;
}
/* A pesquisa manual é grátis (é a conta do admin num assistente), por isso
   pede-se SEMPRE a pesquisa a sério — o equivalente à "pesquisa profunda"
   da automática. Mesmo texto no prompt de um vinho e no do lote. */
/* O mesmo que a `regraIdioma` da vinho-info: o texto sempre em português. */
const IA_MANUAL_IDIOMA='IDIOMA: escreve TODO o texto do JSON em português de Portugal ("notasProva", "harmonizacao", "resumo", "estagioTexto", "subRegiao", "aviso") mesmo que as páginas estejam em inglês, espanhol ou outra língua — TRADUZ, nunca copies. O nome do vinho, o produtor e as castas ficam como são; a região com o nome português ("Douro", nunca "Douro Valley").';
const IA_MANUAL_PESQUISA='PESQUISA OBRIGATÓRIA: antes de responderes, pesquisa MESMO na internet (Pesquisa Google ou a pesquisa web que tiveres) — pelo menos o Vivino do vinho e o preço em lojas portuguesas. NÃO respondas de memória: um valor que não vejas numa página fica vazio, mesmo que aches que sabes. Se não tiveres acesso à internet, diz isso em "aviso" e não preenchas nada.';
const IA_MANUAL_REGRA_CUVEE='Se o produtor tiver mais do que um vinho com este nome (variantes de gama: Reserva, Grande Reserva, Colheita, Terroir, etc.) e não se souber qual, prefere a versão SEM qualificador extra; se essa não existir, escolhe a que tiver mais avaliações no Vivino (a principal da gama, normalmente) e diz no "aviso" que outras versões encontraste e qual escolheste.';

function iaManualPrompt(v,campos,colheitaEspecifica,notas,sites){
  const hoje=new Date().toISOString().slice(0,10);
  const linhas=[`Nome: ${v.nome}`];
  if(v.ano)linhas.push(`Ano (colheita): ${v.ano}`);
  if(v.produtor)linhas.push(`Produtor indicado: ${v.produtor}`);
  if(v.regiao)linhas.push(`Região indicada: ${v.regiao}`);
  if(v.tipo)linhas.push(`Cor: ${v.tipo}`);
  if(notas)linhas.push(`Notas de quem procura: ${notas}`);
  const so=campos&&campos.length&&campos.length<IA_CAMPOS.length
    ?`\nSÓ INTERESSAM ESTES CAMPOS: ${campos.map(k=>IA_CAMPOS_JSON[k]).join(', ')}.\nConcentra-te neles e deixa os outros fora da resposta.\n`:'';
  const sitesTxt=sites&&sites.length
    ?`\nFONTES DE CONFIANÇA: dá prioridade a informação vinda de ${sites.join(', ')}. Só uses outra fonte se estas não tiverem a resposta.\n`:'';
  return `Usa a tua pesquisa na internet para preencheres a ficha deste vinho, como faria um enólogo para a garrafeira de uma casa particular.

${IA_MANUAL_PESQUISA}

VINHO A IDENTIFICAR:
  ${linhas.join('\n  ')}
Hoje é ${hoje}.
${sitesTxt}${so}
REGRAS, e são a sério:
1. NÃO INVENTES. Um campo que não consigas confirmar por pesquisa fica FORA do JSON (ou a null) — uma ficha com metade dos campos certos vale mais do que uma cheia com metade inventada.
2. ${IA_MANUAL_REGRA_CUVEE}
3. ${iaManualRegraVivino(v.ano||null)}
4. Se houver dúvida entre dois vinhos parecidos, escolhe o que bate certo com o ano e a região indicados, e escreve a hesitação em "aviso".
5. O preço é o de UMA garrafa de 0,75L, em euros, em Portugal.
6. As castas vão SEPARADAS, uma a uma, com o nome português corrente ("Touriga Nacional", "Alicante Bouschet"). Nunca "blend"/"lote"/"várias castas".
7. ${v.ano?'"beberDe"/"beberAte" são ANOS (ex.: 2026 e 2034), a janela em que ESTA colheita está no ponto.':'Este vinho não tem ano: sem colheita NÃO há janela de consumo — deixa "beberDe"/"beberAte" de fora.'}
8. "imagemUrl" é o link DIRETO de uma fotografia (acaba em .jpg/.jpeg/.png/.webp/.avif), nunca o link da página. Sem certeza, deixa vazio.
${colheitaEspecifica&&v.ano?`9. ${iaManualRegraColheita(v.ano)}\n`:''}
${IA_MANUAL_IDIOMA}

Responde SÓ com este JSON, sem texto à volta e sem blocos de código \`\`\`:
{
  "encontrado": true,
  "produtor": "",
  "ano": ${v.ano||'null'},
  "tipo": "um de: ${TIPOS.join(' | ')}",
  "estilo": "vazio, ou um de: ${ESTILOS.filter(Boolean).join(' | ')}",
  "regiao": "região vitivinícola",
  "subRegiao": "",
  "mencao": "vazio, ou um de: ${MENCOES.filter(Boolean).join(' | ')}",
  "classificacao": "vazio, ou um de: ${CLASSIF.filter(Boolean).join(' | ')}",
  "castas": ["Touriga Nacional", "Touriga Franca"],
  "teor": 14.5,
  "estagioMeses": 18,
  "estagioTexto": "18 meses em barrica de carvalho francês",
${v.ano?`  "vivinoNota": 4.2,
  "vivinoAvaliacoes": 312,
`:''}  "vivinoNotaGlobal": 4.1,
  "vivinoAvaliacoesGlobal": 5234,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 18.5,
${v.ano?`  "beberDe": 2026,
  "beberAte": 2034,
`:''}  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "aviso": "vazio, ou o que ficou por confirmar"
}

Se não conseguires identificar o vinho de todo, responde {"encontrado": false, "aviso": "porquê"}.`;
}


async function iaManualCopiar(){
  const ta=document.getElementById('ia-manual-prompt');
  if(!ta)return;
  try{
    await navigator.clipboard.writeText(ta.value);
    toast('Prompt copiado ✓');
  }catch(e){
    ta.focus();ta.select();
    toast('Não deu para copiar sozinho — o texto já está selecionado, usa Ctrl/Cmd+C',1);
  }
}

/* Aspas tipográficas (“ ” ‘ ’) não são JSON válido A FAZER DE ESTRUTURA, e
   algumas apps de chat trocam-nas por conta própria ao mostrar texto normal
   (não costuma acontecer dentro de blocos de código) — apanhado com uma
   resposta colada com TODAS as aspas assim, que o JSON.parse recusava logo
   na primeira chave. MAS DENTRO DE UMA STRING SÃO TEXTO VÁLIDO, e trocá-las
   aí parte o JSON (uma aspa reta a meio de uma frase fecha a string) — o
   "própria do nosso “terroir”" da página do Piano Reserva Touriga Nacional,
   29/09/2026. Por isso lê-se primeiro o texto TAL COMO VEIO, e só se não se
   ler é que se trocam as aspas duplas; as simples trocam-se sempre (nunca
   são estrutura). A MESMA regra do `extrairJson` da `vinho-info`. */
function iaManualExtrairJson(txt){
  const s=String(txt||'').trim().replace(/[‘’]/g,"'");
  return iaManualLerJson(s)??iaManualLerJson(s.replace(/[“”]/g,'"'));
}

/* Espelho do `lerJson` da Edge Function: o Gemini às vezes devolve
   texto à volta do JSON ou blocos ```; isto apanha o primeiro objeto
   equilibrado. */
function iaManualLerJson(s){
  if(!s)return null;
  try{return JSON.parse(s);}catch(e){}
  const limpo=s.replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  try{return JSON.parse(limpo);}catch(e){}
  const ini=limpo.indexOf('{');
  if(ini<0)return null;
  let nivel=0,emString=false,escape=false;
  for(let i=ini;i<limpo.length;i++){
    const c=limpo[i];
    if(escape){escape=false;continue;}
    if(c==='\\'){escape=true;continue;}
    if(c==='"'){emString=!emString;continue;}
    if(emString)continue;
    if(c==='{')nivel++;
    else if(c==='}'&&--nivel===0){
      try{return JSON.parse(limpo.slice(ini,i+1));}catch(e){return null;}
    }
  }
  return null;
}

/* Espelho do `normalizar` da Edge Function: mesmo vocabulário fechado
   (TIPOS/ESTILOS/MENCOES/CLASSIF) e os mesmos limites. */
function iaManualTxt(v,max){return String(v==null?'':v).replace(/\s+/g,' ').trim().slice(0,max);}
function iaManualNum(v,min,max,casas){
  casas=casas==null?2:casas;
  const n=typeof v==='number'?v:parseFloat(String(v==null?'':v).replace(',','.'));
  if(!isFinite(n)||n<min||n>max)return null;
  return Number(n.toFixed(casas));
}
function iaManualAno(v){const n=iaManualNum(v,1900,2100,0);return n===null?null:Math.round(n);}
function iaManualDaLista(v,lista){
  const t=iaManualTxt(v,40);
  const achado=lista.find(x=>x&&x.toLowerCase()===t.toLowerCase());
  return achado||'';
}
function iaManualNormalizar(raw,anoPedido,campos){
  if(!raw||typeof raw!=='object')return null;
  if(raw.encontrado===false)return null;
  const castas=Array.isArray(raw.castas)
    ?[...new Set(raw.castas.map(c=>iaManualTxt(c,50))
        .filter(c=>c&&!/^(blend|lote|v[áa]rias|diversas|field blend|castas?)$/i.test(c))
        .map(c=>c.replace(/\s*\(\d+%?\)\s*$/,'').trim()))].slice(0,12)
    :[];
  let beberDe=iaManualAno(raw.beberDe), beberAte=iaManualAno(raw.beberAte);
  if(beberDe!==null&&beberAte!==null&&beberAte<beberDe)beberAte=null;
  const out={
    produtor:iaManualTxt(raw.produtor,90),
    ano:iaManualAno(raw.ano)??anoPedido,
    tipo:iaManualDaLista(raw.tipo,TIPOS),
    estilo:iaManualDaLista(raw.estilo,ESTILOS),
    regiao:iaManualTxt(raw.regiao,60),
    sub_regiao:iaManualTxt(raw.subRegiao,60),
    mencao:iaManualDaLista(raw.mencao,MENCOES),
    classificacao:iaManualDaLista(raw.classificacao,CLASSIF),
    castas,
    teor:iaManualNum(raw.teor,4,25,1),
    estagio_meses:(()=>{const n=iaManualNum(raw.estagioMeses,0,400,0);return n===null?null:Math.round(n);})(),
    estagio_texto:iaManualTxt(raw.estagioTexto,160),
    vivino_nota:iaManualNum(raw.vivinoNota,1,5,2),
    vivino_avaliacoes:(()=>{const n=iaManualNum(raw.vivinoAvaliacoes,0,10000000,0);return n===null?null:Math.round(n);})(),
    vivino_nota_global:iaManualNum(raw.vivinoNotaGlobal,1,5,2),
    vivino_avaliacoes_global:(()=>{const n=iaManualNum(raw.vivinoAvaliacoesGlobal,0,10000000,0);return n===null?null:Math.round(n);})(),
    vivino_url:vivinoLink(raw.vivinoUrl),
    imagem_url:/^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?\S*)?$/i.test(String(raw.imagemUrl||'').trim())?iaManualTxt(raw.imagemUrl,400):'',
    preco_medio:iaManualNum(raw.precoMedio,0.5,100000,2),
    beber_de:beberDe,beber_ate:beberAte,
    notas_prova:iaManualTxt(raw.notasProva,600),
    harmonizacao:iaManualTxt(raw.harmonizacao,300),
    ai_resumo:iaManualTxt(raw.resumo,900),
    aviso:iaManualTxt(raw.aviso,300)
  };
  Object.keys(out).forEach(k=>{
    const v=out[k];
    if(v===null||v===''||(Array.isArray(v)&&!v.length))delete out[k];
  });
  iaVivinoDuas(out,out.ano==null?null:out.ano);
  campos=iaCamposComGlobal(campos,out.ano==null?null:out.ano);
  if(campos&&campos.length)Object.keys(out).forEach(k=>{if(k!=='aviso'&&!campos.includes(k))delete out[k];});
  return Object.keys(out).length?out:null;
}

/* As duas notas do Vivino, arrumadas depois de lidas — espelho do
   `vivinoDuas` da vinho-info.ts: sem colheita a "da colheita" passa a ser a
   de todas; as duas iguais (nota e avaliações) é cópia, fica só a de todas;
   uma colheita com mais avaliações do que o vinho todo deita a de todas fora. */
function iaVivinoDuas(out,ano){
  const tem=k=>out[k]!==undefined;
  if(ano===null){
    if(tem('vivino_nota')&&!tem('vivino_nota_global')){
      out.vivino_nota_global=out.vivino_nota;
      if(tem('vivino_avaliacoes')&&!tem('vivino_avaliacoes_global'))out.vivino_avaliacoes_global=out.vivino_avaliacoes;
    }
    delete out.vivino_nota;delete out.vivino_avaliacoes;
    return;
  }
  if(tem('vivino_nota')&&tem('vivino_nota_global')&&out.vivino_nota===out.vivino_nota_global&&
     (out.vivino_avaliacoes??null)===(out.vivino_avaliacoes_global??null)){
    delete out.vivino_nota;delete out.vivino_avaliacoes;
    return;
  }
  if(tem('vivino_avaliacoes')&&tem('vivino_avaliacoes_global')&&
     Number(out.vivino_avaliacoes)>Number(out.vivino_avaliacoes_global)){
    delete out.vivino_nota_global;delete out.vivino_avaliacoes_global;
  }
}

/* Cola-se a resposta, valida-se, e entra-se no MESMO ecrã de comparação da
   pesquisa automática (`iaMostrarResultado`) — é genérico o suficiente
   para não saber (nem precisar de saber) que o que está a comparar não
   veio de uma chamada à Edge Function. No fim compara-se também com o
   CATÁLOGO partilhado, se ele souber alguma coisa deste vinho: é grátis,
   é só ler o que já lá está (`catComparar`), e reaproveita o mesmíssimo
   mecanismo de "duas leituras, escolhe uma" que a segunda opinião já usa. */

/* ── ATUALIZAÇÃO MASSIVA (lote) ──────────────────────────────────────
   Nasceu de uma pergunta simples: em vez de abrir vinho a vinho para
   pedir "só a nota do Vivino", porque não escolher vários de uma vez e
   pedir uma vez só? Cada pesquisa com pesquisa web é um pedido pago à
   parte dos tokens (é o que a análise dos logs mostrou), por isso o que
   poupa dinheiro a sério aqui não é o modelo escolhido — é PEDIR MENOS
   VEZES. A automática em lote ainda faz uma chamada por vinho (não há
   como pedir vários vinhos ao `vinho-info` numa chamada só); quem quer
   poupar a sério usa a manual, que é UM prompt só para todos.

   Não é um caminho de escrita novo nenhum: os passos 2 (campos) e 4
   (comparar) reaproveitam tal e qual `IA_CAMPOS`, `iaManualNormalizar`,
   `iaMostrarResultado` e `iaAplicar` — só o passo 1 (escolher vinhos, na
   própria lista de Detalhe) e o 3 (gerar o pedido, um por um ou todos de
   uma vez) são código novo. Duas cópias da comparação campo a campo
   divergiam no dia em que alguém mexesse só numa. */
const LOTE_MAX_VINHOS=10, LOTE_MAX_CAMPOS=5;
let LOTE_SEL_MODO=false;
let LOTE_SEL=new Map();         // id -> {id,nome,ano,produtor,tipo,regiao}
let LOTE_CAMPOS=[];             // até LOTE_MAX_CAMPOS chaves de IA_CAMPOS
let LOTE_FILA=[], LOTE_IDX=0, LOTE_RESULTADOS=null;
let IA_LOTE_ATIVO=false;        // `iaMostrarResultado`/`iaAplicar` leem isto para saber que estão a meio de um lote

function fabSincronizar(){
  const w=document.getElementById('fab-wrap');
  /* O "+" só onde se acrescenta alguma coisa (o dono das apps, 30/09/2026):
     no Detalhe da garrafeira (novo vinho, atualização massiva, importar) e
     na Wishlist (e aí vai direto a "Adicionar à wishlist"). Nem no Resumo,
     nem em Locais, Consumidos ou Definições, nem no catálogo (fase 1). */
  const ha=modoCat()?(tabAtiva==='detalhe'&&catPodeCriar())
    :(tabAtiva==='detalhe'||(tabAtiva==='desejos'&&TEM_DESEJO));
  if(w)w.style.display=(LOTE_SEL_MODO||!ha)?'none':'';
  if(!ha)fabFechar();
  // No mapa dos locais o `ajustarEstantes` reserva espaço para o FAB — se
  // ele aparece/desaparece sem um redesenho a seguir, a última prateleira
  // ficava a discordar do que se vê (por baixo ou por cima do "+").
  if(tabAtiva==='locais')ajustarEstantes();
}

// ── Passo 1: escolher até LOTE_MAX_VINHOS na lista de Detalhe ──
function loteAbrir(){
  if(roGuard())return;
  if(!podeUsarIA()){toast('A pesquisa por IA não está incluída no teu acesso',1);return;}
  const btn=document.querySelector('.itabs .it[onclick^="tab(\'detalhe\'"]');
  tab('detalhe',btn);
  LOTE_SEL_MODO=true;
  LOTE_SEL=new Map();
  fabSincronizar();
  document.getElementById('lotebar').classList.add('on');
  loteSelBarra();
  renderDetalhe();
}
function loteSelCancelar(){
  LOTE_SEL_MODO=false;
  LOTE_SEL=new Map();
  fabSincronizar();
  document.getElementById('lotebar').classList.remove('on');
  renderDetalhe();
}
function loteSelTem(id){return LOTE_SEL.has(id);}
function loteSelCheio(){return LOTE_SEL.size>=LOTE_MAX_VINHOS;}
function loteSelToggle(id){
  if(LOTE_SEL.has(id)){
    LOTE_SEL.delete(id);
  }else{
    if(loteSelCheio()){toast('Já tens '+LOTE_MAX_VINHOS+' vinhos — tira um para escolheres outro',1);return;}
    const v=IDXV[id];if(!v)return;
    LOTE_SEL.set(id,{id:v.id,nome:v.nome,ano:v.ano,produtor:v.produtor,tipo:v.tipo,regiao:v.regiao});
  }
  loteSelBarra();
  renderDetalhe();
}
function loteSelBarra(){
  const n=LOTE_SEL.size;
  const et=document.getElementById('lotebar-n');
  if(et)et.textContent=n+'/'+LOTE_MAX_VINHOS+' selecionados';
  const btn=document.getElementById('lotebar-seguinte');
  if(btn)btn.disabled=!n;
}
function loteSelSeguinte(){
  if(!LOTE_SEL.size)return;
  LOTE_SEL_MODO=false;
  fabSincronizar();
  document.getElementById('lotebar').classList.remove('on');
  renderDetalhe();
  loteCampos();
}
function loteVoltarSelecao(){
  fecharModal('modal-lote');
  LOTE_SEL_MODO=true;
  fabSincronizar();
  document.getElementById('lotebar').classList.add('on');
  loteSelBarra();
  renderDetalhe();
}
function loteChipsHTML(){
  return `<div class="lote-chips">${[...LOTE_SEL.values()].map(v=>
    `<span class="lote-chip"><span>${esc(v.nome||'(sem nome)')}</span>${
      v.ano?`<em>${esc(String(v.ano))}</em>`:''}</span>`).join('')}</div>`;
}

// ── Passo 2: escolher até LOTE_MAX_CAMPOS campos, para todos os vinhos escolhidos ──
function loteCampos(){
  LOTE_CAMPOS=[];
  const vinhos=[...LOTE_SEL.values()];
  const n=vinhos.length;
  const linhas=IA_CAMPOS.map(c=>{
    const vazios=vinhos.filter(vs=>!iaValorAtual(IDXV[vs.id]||{},c.k)).length;
    return `<label class="ia-esc">
      <input type="checkbox" class="lote-esc-c" value="${esc(c.k)}" onchange="loteToggleCampo('${escJs(c.k)}')">
      <span>${esc(c.rot)}${vazios?` <i>vazio em ${vazios} de ${n}</i>`:' <i>já têm todos</i>'}</span>
    </label>`;
  }).join('');
  document.getElementById('modal-lote-in').innerHTML=`
    <div class="mtop"><h3>🔎 Atualização massiva</h3><button class="mx" onclick="fecharModal('modal-lote')">✕</button></div>
    <div class="note" style="margin-top:3px">${n} vinho${n>1?'s':''} escolhido${n>1?'s':''}</div>
    ${loteChipsHTML()}
    <div class="aviso" style="margin-top:10px">Escolhe até <b>${LOTE_MAX_CAMPOS} campos</b> — poucos, e a pesquisa
      (automática ou manual) sai mais precisa. O número ao lado de cada um diz a quantos destes vinhos falta.</div>
    <div class="ia-escbar"><span class="note" id="lote-esc-n">0 de ${LOTE_MAX_CAMPOS} campos</span></div>
    <div class="ia-escs">${linhas}</div>
    <div class="macoes">
      <button class="btn prim" id="lote-campos-btn" onclick="loteAutoManual()" disabled>Seguinte ›</button>
      <button class="btn ghost" onclick="loteVoltarSelecao()">‹ Voltar aos vinhos</button>
    </div>`;
  abrirModal('modal-lote');
}
function loteToggleCampo(k){
  const cx=document.querySelector('.lote-esc-c[value="'+CSS.escape(k)+'"]');
  const i=LOTE_CAMPOS.indexOf(k);
  if(i>=0){
    LOTE_CAMPOS.splice(i,1);
  }else{
    if(LOTE_CAMPOS.length>=LOTE_MAX_CAMPOS){
      toast('Já tens '+LOTE_MAX_CAMPOS+' campos — tira um para escolheres outro',1);
      if(cx)cx.checked=false;
      return;
    }
    LOTE_CAMPOS.push(k);
  }
  const et=document.getElementById('lote-esc-n');
  if(et)et.textContent=LOTE_CAMPOS.length+' de '+LOTE_MAX_CAMPOS+' campos';
  const btn=document.getElementById('lote-campos-btn');
  if(btn)btn.disabled=!LOTE_CAMPOS.length;
}

// ── Passo 3: automática (uma chamada por vinho) ou manual (um prompt só) ──
async function loteAutoManual(){
  if(!LOTE_CAMPOS.length)return;
  const vinhos=[...LOTE_SEL.values()];
  document.getElementById('modal-lote-in').innerHTML=`
    <div class="mtop"><h3>🔎 Atualização massiva</h3><button class="mx" onclick="fecharModal('modal-lote')">✕</button></div>
    <div class="note" style="margin-top:3px">${vinhos.length} vinho${vinhos.length>1?'s':''} · ${LOTE_CAMPOS.length} campo${LOTE_CAMPOS.length>1?'s':''}</div>
    <div id="lote-aviso-rep"></div>
    <div style="display:flex;flex-direction:column;gap:14px;margin-top:14px">
      <div><button class="btn ghost full" onclick="loteAutomatica()">🔎 Pesquisa automática</button>
        <div class="note" style="margin-top:5px">Paga — a ${esc(rotuloMotor(motorDoPlano()))}, uma pesquisa por
          vinho (${vinhos.length} pesquisas no total).</div></div>
      <div><button class="btn prim full" onclick="loteManual()">✍️ Pesquisa manual</button>
        <div class="note" style="margin-top:5px">Grátis — um prompt só, para os ${vinhos.length} vinhos de uma vez;
          copias para o assistente de IA que preferires e colas a resposta aqui.</div></div>
    </div>
    <div class="macoes"><button class="btn ghost" onclick="loteCampos()">‹ Voltar</button></div>`;
  abrirModal('modal-lote');
  // Informativo, não bloqueia: diz quais destes vinhos já foram pesquisados
  // há menos de 30 dias, para quem preferir saltá-los ou ir pela manual em
  // vez de pagar outra pesquisa a um campo que provavelmente continua vazio.
  const recentes=[];
  for(const v of vinhos){
    try{if(await iaUltimaProcura(v.id))recentes.push(v.nome);}catch(e){}
  }
  const el=document.getElementById('lote-aviso-rep');
  if(el&&recentes.length)el.innerHTML=`<div class="aviso" style="margin-top:10px">
    <b>${recentes.length} d${recentes.length>1?'estes vinhos já foram':'este vinho já foi'} pesquisado${recentes.length>1?'s':''}
    há menos de 30 dias:</b> ${esc(recentes.join(', '))}. A automática pesquisa-os à mesma — se for só para confirmar
    um campo que continua vazio, considera saltá-los ou usar a manual, que não custa nada.</div>`;
}

// ── 3a. Automática: UMA chamada para todos os vinhos ──
// Já foi "uma pesquisa por vinho, sequencial" — e isso continuava a pagar
// N pesquisas por um lote de N, o mesmo problema que a manual (um prompt
// só) resolvia. Agora `iaPedirLote` manda os vinhos todos de uma vez e o
// `vinho-info.ts` é que faz uma chamada só ao Gemini para o lote inteiro.
let LOTE_AUTO_VINHOS=[];
async function loteAutomatica(){
  LOTE_AUTO_VINHOS=[...LOTE_SEL.values()];
  fecharModal('modal-lote');
  IA_LOTE_ATIVO=true;
  await loteAutomaticaExecutar();
}
async function loteAutomaticaExecutar(){
  const n=LOTE_AUTO_VINHOS.length;
  IA_MOTOR=motorDoPlano();
  iaMostrarEspera(`${n} vinho${n>1?'s':''} de uma vez`,IA_MOTOR);
  try{
    const res=await iaPedirLote(LOTE_AUTO_VINHOS,LOTE_CAMPOS,IA_MOTOR);
    loteAplicarResultadoAutomatico(res);
  }catch(e){
    loteMostrarErroLote(e.message);
  }
}
// A resposta já vem pronta a comparar (a mesma forma que a manual produz
// depois de colada) — só falta separar por vinho e entrar no mesmo ecrã.
function loteAplicarResultadoAutomatico(res){
  const lista=res&&Array.isArray(res.resultados)?res.resultados:[];
  const porId=new Map(lista.map(r=>[Number(r&&r.id),r]));
  LOTE_RESULTADOS=new Map();
  LOTE_FILA=[];
  LOTE_AUTO_VINHOS.forEach(v=>{
    const r=porId.get(v.id);
    if(!r||r.encontrado===false)return;
    const ficha={...r};
    delete ficha.id;delete ficha.encontrado;
    LOTE_RESULTADOS.set(v.id,ficha);
    LOTE_FILA.push(v.id);
  });
  if(!LOTE_FILA.length){
    loteMostrarErroLote('A pesquisa não trouxe nada de aproveitável para nenhum destes vinhos.');
    return;
  }
  LOTE_IDX=0;
  loteMostrarAtual();
}
function loteMostrarErroLote(msg){
  const n=LOTE_AUTO_VINHOS.length;
  document.getElementById('modal-ia-in').innerHTML=`
    <div class="mtop"><h3>Não deu</h3><button class="mx" onclick="fecharModal('modal-ia')">✕</button></div>
    <div class="note" style="margin-top:3px">${n} vinho${n>1?'s':''}</div>
    <div class="erro">${esc(msg)}</div>
    <div class="macoes">
      <button class="btn prim" onclick="loteAutomaticaExecutar()">Tentar outra vez</button>
      <button class="btn ghost" onclick="fecharModal('modal-ia')">Parar aqui</button>
    </div>`;
  abrirModal('modal-ia');
}

// ── 3b. Manual: um prompt só, para todos os vinhos escolhidos ──
// Espelho do `iaManualPrompt`/`IA_MANUAL_REGRA_CUVEE`/`iaManualRegraVivino`
// de um vinho só, só que com um "id" por vinho para se saber, na resposta
// colada, a que vinho pertence cada objeto — sem depender da ordem.
function loteManualCampoExemplo(k){
  const EX={
    tipo:`"um de: ${TIPOS.join(' | ')}"`,
    estilo:`"vazio, ou um de: ${ESTILOS.filter(Boolean).join(' | ')}"`,
    regiao:'"região vitivinícola"', sub_regiao:'""',
    mencao:`"vazio, ou um de: ${MENCOES.filter(Boolean).join(' | ')}"`,
    classificacao:`"vazio, ou um de: ${CLASSIF.filter(Boolean).join(' | ')}"`,
    castas:'["Touriga Nacional", "Touriga Franca"]',
    teor:'14.5', estagio_meses:'18', estagio_texto:'"18 meses em barrica de carvalho francês"',
    vivino_nota:'4.2', vivino_avaliacoes:'312',
    vivino_nota_global:'4.1', vivino_avaliacoes_global:'5234', vivino_url:'""', imagem_url:'""',
    preco_medio:'18.5', beber_de:'2026', beber_ate:'2034',
    notas_prova:'"duas ou três frases sobre aroma, boca e final"',
    harmonizacao:'"com que pratos"', ai_resumo:'"duas ou três frases sobre o vinho e o produtor"',
  };
  return k in EX?EX[k]:'null';
}
function loteManualRegras(campos){
  const r=['NÃO INVENTES. Um campo que não confirmes por pesquisa fica FORA do objeto desse vinho (ou null) — '+
      'uma ficha com metade dos campos certos vale mais do que uma cheia com metade inventada.',
    IA_MANUAL_REGRA_CUVEE];
  if(campos.some(k=>k.startsWith('vivino_')))r.push(iaManualRegraVivino(undefined));
  if(campos.includes('castas'))r.push('Castas separadas por nome (nunca "blend"/"lote"/"várias castas").');
  if(campos.includes('imagem_url'))r.push('"imagemUrl" é o link DIRETO de uma fotografia (acaba em '+
    '.jpg/.jpeg/.png/.webp/.avif), nunca o link da página.');
  if(campos.includes('preco_medio'))r.push('"precoMedio" é o preço de UMA garrafa de 0,75L, em euros, em Portugal.');
  if(campos.includes('beber_de')||campos.includes('beber_ate'))r.push('"beberDe"/"beberAte" são anos, a janela da '+
    'colheita indicada. Um vinho SEM ano na lista não tem janela de consumo: deixa "beberDe"/"beberAte" de fora do objeto dele.');
  r.push('O "id" de cada resultado tem de ser EXATAMENTE o "id" da lista de entrada — é assim que sei a que '+
    'vinho corresponde cada objeto, nunca pela posição na lista.');
  r.push('Se não conseguires identificar um vinho de todo, o objeto dele fica só '+
    '{"id": <id>, "encontrado": false, "aviso": "porquê"} — sem inventar os outros campos.');
  return r;
}
function loteManualPrompt(vinhos,campos){
  // A nota da colheita traz a de todas (no lote ficam as duas: cada vinho
  // tem ou não o seu ano).
  campos=iaCamposComGlobal(campos,undefined);
  const hoje=new Date().toISOString().slice(0,10);
  const nomesCampos=campos.map(k=>IA_CAMPOS_JSON[k]||k);
  const linhas=vinhos.map(v=>
    `- id: ${v.id} | nome: ${v.nome} | produtor: ${v.produtor||'(desconhecido)'}`+
    (v.ano?` | ano: ${v.ano}`:'')+(v.tipo?` | cor: ${v.tipo}`:'')).join('\n');
  const camposObj=campos.map(k=>`      "${IA_CAMPOS_JSON[k]||k}": ${loteManualCampoExemplo(k)}`).join(',\n');
  const regras=loteManualRegras(campos).map((r,i)=>`${i+1}. ${r}`).join('\n');
  return `Usa a tua pesquisa na internet para preencheres, PARA CADA VINHO da lista abaixo, só os campos pedidos — como faria um enólogo a atualizar uma garrafeira de referência.

${IA_MANUAL_PESQUISA} Faz pelo menos uma pesquisa POR VINHO.

Hoje é ${hoje}.
CAMPOS A PEDIR (só estes, para todos os vinhos): ${nomesCampos.join(', ')}.

VINHOS A IDENTIFICAR:
${linhas}

REGRAS, e são a sério:
${regras}

${IA_MANUAL_IDIOMA}

Responde SÓ com este JSON, sem texto à volta e sem blocos de código \`\`\`, com exatamente ${vinhos.length} objeto${vinhos.length>1?'s':''} em "resultados" (um por vinho, pela mesma ordem):
{
  "resultados": [
    {
      "id": ${vinhos[0].id},
      "encontrado": true,
${camposObj},
      "aviso": "vazio, ou o que ficou por confirmar"
    }
  ]
}`;
}
function loteManual(){
  const vinhos=[...LOTE_SEL.values()];
  const txt=loteManualPrompt(vinhos,LOTE_CAMPOS);
  document.getElementById('modal-lote-in').innerHTML=`
    <div class="mtop"><h3>✍️ Pesquisa manual em lote</h3><button class="mx" onclick="fecharModal('modal-lote')">✕</button></div>
    <div class="aviso">1. Copia o prompt. 2. Cola-o num assistente de IA com pesquisa na internet ligada (Gemini,
      ChatGPT, Claude…). 3. Copia a resposta toda (o JSON) e cola-a na caixa de baixo. 4. Carrega em Comparar — entra-se
      vinho a vinho, tal como numa pesquisa normal.</div>
    <label>Prompt a copiar</label>
    <textarea id="lote-manual-prompt" readonly rows="8" onclick="this.select()">${esc(txt)}</textarea>
    <button class="btn ghost full" style="margin-top:8px" onclick="loteManualCopiar()">📋 Copiar prompt</button>
    <label style="margin-top:16px">Resposta (cola aqui)</label>
    <textarea id="lote-manual-resposta" rows="12" placeholder="Cola aqui o JSON que o modelo devolveu…"></textarea>
    <div class="note" id="lote-manual-erro" style="margin-top:6px;color:var(--dg)"></div>
    <div class="macoes">
      <button class="btn prim" onclick="loteManualColar()">Comparar</button>
      <button class="btn ghost" onclick="loteAutoManual()">‹ Voltar</button>
    </div>`;
  abrirModal('modal-lote');
}
async function loteManualCopiar(){
  const ta=document.getElementById('lote-manual-prompt');
  if(!ta)return;
  try{
    await navigator.clipboard.writeText(ta.value);
    toast('Prompt copiado ✓');
  }catch(e){
    ta.focus();ta.select();
    toast('Não deu para copiar sozinho — o texto já está selecionado, usa Ctrl/Cmd+C',1);
  }
}
function loteManualColar(){
  const erroEl=document.getElementById('lote-manual-erro');
  const txt=document.getElementById('lote-manual-resposta').value;
  const raw=iaManualExtrairJson(txt);
  const lista=raw&&Array.isArray(raw.resultados)?raw.resultados:null;
  if(!lista){
    if(erroEl)erroEl.textContent='Não consegui ler a resposta colada como JSON — confirma que colaste o texto '+
      'todo, incluindo as chavetas { } e "resultados".';
    return;
  }
  if(erroEl)erroEl.textContent='';
  const vinhos=[...LOTE_SEL.values()];
  const porId=new Map(lista.map(r=>[Number(r&&r.id),r]));
  LOTE_RESULTADOS=new Map();
  LOTE_FILA=[];
  vinhos.forEach(v=>{
    const r=porId.get(v.id);
    if(!r||r.encontrado===false)return;
    const ficha=iaManualNormalizar(r,v.ano||null,LOTE_CAMPOS);
    if(!ficha)return;
    ficha.modelo=IA_MANUAL_MARCA;
    ficha.pesquisa=true;
    LOTE_RESULTADOS.set(v.id,ficha);
    LOTE_FILA.push(v.id);
  });
  if(!LOTE_FILA.length){
    if(erroEl)erroEl.textContent='A resposta leu-se, mas não trouxe nenhum campo aproveitável para nenhum destes vinhos.';
    return;
  }
  LOTE_IDX=0;
  IA_LOTE_ATIVO=true;
  fecharModal('modal-lote');
  loteMostrarAtual();
}

// ── Passo 4: comparar, vinho a vinho — reaproveita `iaMostrarResultado`/`iaAplicar` tal como estão ──
function loteMostrarAtual(){
  const vinhoId=LOTE_FILA[LOTE_IDX];
  const res=LOTE_RESULTADOS.get(vinhoId);
  IA_RES2=null;IA_MOTOR2='';IA_ERRO2='';
  iaMostrarResultado(res,vinhoId);
}
function loteAvancar(){
  LOTE_IDX++;
  // Automática e manual chegam aqui com os resultados TODOS já em mãos (uma
  // chamada só, feita antes de entrar neste ecrã) — não há "ir buscar o
  // próximo", só mostrar o que já se tem.
  if(LOTE_IDX>=LOTE_FILA.length){fecharModal('modal-ia');return;}
  loteMostrarAtual();
}
function loteSaltar(){loteAvancar();}
// Chamado por `fecharModal('modal-ia')`, seja pelo ✕, Escape, a margem ou o
// fim natural do lote — é o único sítio por onde TODOS esses caminhos
// passam, por isso é aqui que se arruma o estado, sem repetir a limpeza em
// cada botão.
function loteAoFecharModalIA(){
  if(!IA_LOTE_ATIVO)return;
  const total=LOTE_FILA.length, feitos=LOTE_IDX;
  IA_LOTE_ATIVO=false;
  LOTE_FILA=[];LOTE_RESULTADOS=null;LOTE_SEL=new Map();LOTE_AUTO_VINHOS=[];
  renderLista();
  toast(feitos>=total?'Atualização massiva concluída ✓':`Atualização massiva parada — ${feitos} de ${total} vistos`);
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
  comentariosIrPara();
  comentariosAvisos(true);
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
  if(el)el.textContent=_sbSession?_sbSession.user.email:'';
  const papel=document.getElementById('conta-papel');
  if(papel)papel.textContent=(isAdmin()
    ?'Admin da app. '
    :(souEditor()?'Editor da tua garrafeira. ':'Só podes ver. '))
    +(garrafeiraAtiva()&&!souDonoDaGarrafeira()
      ?`A ver a garrafeira de ${donoGarrafeira()} (só leitura).`:'');
  const sobre=document.getElementById('sobre-box');
  if(sobre)sobre.innerHTML=`${nomeGarrafeira()?'<b>'+esc(nomeGarrafeira())+'</b>: ':''}${db.vinhos.length} vinhos · ${db.garrafas.length} garrafas (${db.garrafas.filter(naGarrafeira).length} na garrafeira) · ${db.locais.length} locais. ${db.castas.length} castas.<br>Admin: <b>${esc(ADMIN_EMAIL)}</b>.`;
  renderCfgGarrafeira();
  renderCfgLocais();
  if(tabAtiva==='cfg')renderMeusComentarios();
  if(isAdmin()){admRenderPedidos();admRenderUtilizadores();}
}

/* ── LOCAIS (config) ───────────────────────────────────────────────── */
/* Os dois comandos de cada local desenham-se em SVG e não com os emoji
   ✏️/✕: dentro do grupo com moldura, um emoji colorido do sistema é a
   coisa mais berrante de um cartão feito de papel e bordô, e muda de
   desenho de telemóvel para telemóvel. Aqui tomam a cor do botão — bordô
   no editar, vermelho no apagar — que é o que os separa um do outro. */
const ICO_LAPIS='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.9V20h3.1L17.2 9.9l-3.1-3.1L4 16.9zm15.7-9.5a.9.9 0 000-1.2l-1.9-1.9a.9.9 0 00-1.2 0l-1.5 1.5 3.1 3.1 1.5-1.5z" fill="currentColor"/></svg>';
const ICO_X='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function renderCfgLocais(){
  const box=document.getElementById('cfg-locais');
  if(!box)return;
  if(!db.locais.length){box.innerHTML='<div class="note" style="padding:8px 0">Ainda não há locais. Cria o primeiro.</div>';return;}
  box.innerHTML=db.locais.map(l=>{
    const n=db.garrafas.filter(g=>g.local_id===l.id&&naGarrafeira(g)).length;
    const lay=resumoLayoutLocal(l);
    const meta=[l.descricao,lay].filter(Boolean).join(' · ');
    return `<div class="loc-row">
      <span class="loc-pip" style="background:${esc(l.cor||'#7b1f3d')}"></span>
      <div class="loc-txt">
        <div class="loc-nome">${esc(l.nome)}</div>
        <div class="loc-meta"><span class="loc-n">${n}</span>${n===1?'garrafa':'garrafas'}${meta?` · ${esc(meta)}`:''}</div>
      </div>
      <div class="loc-acoes">
        <button type="button" class="loc-ac" title="Editar" aria-label="Editar ${esc(l.nome)}" onclick="editarLocal(${l.id})">${ICO_LAPIS}</button>
        <button type="button" class="loc-ac del" title="Apagar" aria-label="Apagar ${esc(l.nome)}" onclick="apagarLocal(${l.id})">${ICO_X}</button>
      </div>
    </div>`;
  }).join('');
}
let LOC_LAYOUT_EDIT=[];
let LOC_PAREDES={esq:false,dir:false,topo:false};
let LOC_TOPO=0;
const PAREDES_LADOS=[['esq','Esquerda'],['dir','Direita'],['topo','Em cima']];
function locSetParede(lado,v){
  LOC_PAREDES[lado]=!!v;
  renderLocalLayoutEditor();
}
function locSetTopoCap(v){
  LOC_TOPO=Math.max(0,Math.min(60,inteiro(v)||0));
}
function locSetEncosto(i,lado,v){
  const p=LOC_LAYOUT_EDIT[i];
  if(!p)return;
  if(lado==='dir')p.encosto_dir=!!v;else p.encosto_esq=!!v;
}
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
  /* O ENCOSTO é por nível e por lado: numa estante a sério há níveis onde
     a garrafa cabe de lado e outros onde não (uma prateleira mais
     comprida, um puxador, um tubo). O código do lugar (15D/15E) sai do
     NÚMERO do nível e não da ordem no array, para ser o que se lê no
     rótulo — e por isso não empurra a numeração de mais ninguém. */
  const encostoSel=(i,p)=>{
    const lados=PAREDES_LADOS.filter(([id])=>id!=='topo'&&LOC_PAREDES[id]);
    if(!lados.length)return '';
    const num=numeroDoNivel(p.nome,i);
    /* A MESMA pele do "Encaixa na de baixo" (`ll-enc`) e não um `.chk`
       genérico: dentro de um modal, `.mbox label` ganha a um `.chk` (duas
       classes contra uma) e punha isto em MAIÚSCULAS a 10px, em bloco e
       sem quebrar linha — o rótulo saía pela borda do cartão fora ("CABE
       U…") com a caixa nativa azul por baixo. Duas linhas irmãs no mesmo
       cartão têm de se ler como irmãs. */
    return `<div class="ll-encosto">${lados.map(([id,nm])=>`
      <label class="ll-enc ll-enc-pd"><input type="checkbox"${(id==='dir'?p.encosto_dir:p.encosto_esq)?' checked':''}
        onchange="locSetEncosto(${i},'${id}',this.checked)"><span>Cabe uma garrafa à ${nm.toLowerCase()} <i>(lugar ${num}${id==='dir'?'D':'E'})</i></span></label>`).join('')}</div>`;
  };
  const uma=LOC_LAYOUT_EDIT.length<=1;
  /* AS PAREDES do móvel, e o que elas abrem. Uma parede não é decoração:
     é ela que cria o vão onde cabe uma garrafa a mais — ao lado de cada
     nível (o encosto) e em cima do último. Sem parede não há vão, e por
     isso os encostos só aparecem depois de a parede estar ligada. */
  const paredesHTML=`
    <div class="ll-par">
      <div class="msec">Paredes</div>
      <div class="note">Se o móvel está encostado a uma parede, dá para aproveitar o vão entre o fim das prateleiras e ela.</div>
      <div class="segbtns">${PAREDES_LADOS.map(([id,nm])=>
        `<button type="button" class="segbtn${LOC_PAREDES[id]?' on':''}" onclick="locSetParede('${id}',${LOC_PAREDES[id]?'false':'true'})">${nm}${LOC_PAREDES[id]?' ✓':''}</button>`).join('')}</div>
      ${LOC_PAREDES.topo?`<div class="ll-topo"><span>Garrafas em cima do móvel</span>
        <input type="number" inputmode="numeric" min="0" max="60" value="${esc(LOC_TOPO)}" oninput="locSetTopoCap(this.value)" aria-label="Quantas garrafas cabem em cima"></div>
        <div class="note">Ficam numeradas T1, T2… e encostadas à parede, sem mexer na numeração dos níveis.</div>`:''}
    </div>`;
  box.innerHTML=`
    <div class="note">A app desenha este local como estante: uma prateleira por linha, o Nível 1 em baixo. Os lugares são numerados de seguida ao longo do móvel — se o primeiro nível tem 4 lugares, o segundo começa no 5.</div>
    ${paredesHTML}
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
        ${oddSel(i,p)}${encSel(i,p)}${encostoSel(i,p)}
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
  const paredes={};
  PAREDES_LADOS.forEach(([id])=>{if(LOC_PAREDES[id])paredes[id]=true;});
  const prateleiras=LOC_LAYOUT_EDIT.map((p,i)=>{
    const nome=String((p&&p.nome)||'').trim()||`Nível ${i+1}`;
    const capacidade=Math.max(1,Math.min(240,inteiro((p&&p.capacidade))||0));
    const formato=normalizarFormatoPrateleira(p&&p.formato);
    const mais_em=normalizarSobrepostosMaisEm(p&&p.mais_em);
    // `mais_em` só se guarda onde conta (sobrepostos de capacidade ímpar),
    // e `encaixe` só onde é verdade — um layout que não os precise fica
    // sem eles em vez de os levar a falso por todo o lado
    const enc=!!(p&&p.encaixe)&&i>0;
    // os encostos só se guardam do lado que TEM parede: um encosto sem
    // parede é um lugar que não existe
    const ed=!!(p&&p.encosto_dir)&&!!LOC_PAREDES.dir;
    const ee=!!(p&&p.encosto_esq)&&!!LOC_PAREDES.esq;
    return capacidade?Object.assign({nome,capacidade,formato},
      formato==='sobrepostos'&&capacidade%2?{mais_em}:{}, enc?{encaixe:true}:{},
      ed?{encosto_dir:true}:{}, ee?{encosto_esq:true}:{}) : null;
  }).filter(Boolean);
  if(!prateleiras.length)throw new Error('Cria pelo menos uma prateleira para ligar o desenho.');
  const vistos=new Set();
  for(const p of prateleiras){
    const k=chave(p.nome);
    if(vistos.has(k))throw new Error('Cada prateleira precisa de um nome diferente.');
    vistos.add(k);
  }
  const out={prateleiras};
  if(Object.keys(paredes).length)out.paredes=paredes;
  if(LOC_PAREDES.topo&&LOC_TOPO>0)out.topo={capacidade:LOC_TOPO};
  return out;
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
  LOC_PAREDES=paredesLocal(l);
  LOC_TOPO=topoLocal(l);
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
        <div class="note">O que o admin da app pode fazer na tua garrafeira.</div>
        <select id="ga-admin" onchange="guardarAcessoAdmin(this.value)">
          <option value="nenhuma"${g.admin_acesso==='nenhuma'?' selected':''}>Nada</option>
          <option value="leitura"${g.admin_acesso==='leitura'?' selected':''}>Ver</option>
          <option value="edicao"${g.admin_acesso==='edicao'?' selected':''}>Ver e mexer</option>
        </select>
        <div class="note" id="ga-admin-status"></div>`}

        <h4 style="margin-top:18px">Quem pode ver</h4>
        <div class="note">Veem as tuas garrafas, sem mexer.</div>
        <div id="cfg-partilhas"></div>
        <div class="linha-add">
          <input type="email" id="ga-partilhar" placeholder="email@exemplo.com">
          <button class="btn prim" onclick="partilharGarrafeira()">Dar acesso</button>
        </div>
        <div class="note" id="ga-partilhar-status"></div>

        <h4 style="margin-top:18px">Passar a garrafeira</h4>
        <div class="note">As garrafas, os locais e o histórico passam para a conta de outra pessoa.</div>
        <div class="linha-add">
          <input type="email" id="ga-passar" placeholder="email@exemplo.com">
          <button class="btn danger" onclick="passarGarrafeira()">Passar</button>
        </div>
        <div class="note" id="ga-passar-status"></div>

        <h4 style="margin-top:18px">Outra garrafeira</h4>
        <div class="note">Por exemplo, a da casa de férias.</div>
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
  {v:'premium',r:'IA com pesquisa web'}
];
async function admRenderUtilizadores(){
  const box=document.getElementById('adm-users-list');
  if(!box)return;
  try{
    _admUsers=await sbReq('GET','allowed_users?select=email,nome,pode_editar,ia_plano&order=email.asc')||[];
  }catch(e){box.innerHTML=`<div class="note">${esc(e.message)}</div>`;return;}
  // Os curadores do catálogo: a lista é do CATÁLOGO e só o admin dele a vê
  // e muda (`db/curadores.sql` da WineCatalog). Sem isso, o visto não
  // aparece — nem a quem é só admin da Garrafeira.
  let curadores=null;
  if(EU.admin_catalogo){
    try{curadores=await sbReq('POST','rpc/curadores_listar',{},{'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'})||[];}
    catch(e){curadores=null;}
  }
  const curSet=new Set((curadores||[]).map(x=>String(x).toLowerCase()));
  const curChk=u=>curadores==null?'':`<label class="chk" title="Cria vinhos no Catálogo, e o que corrige na sua garrafeira corrige também o vinho no catálogo"><input type="checkbox"${curSet.has(u.email.toLowerCase())?' checked':''}
              onchange="admDefinirCurador('${escJs(u.email)}',this.checked)"> Curador do catálogo</label>`;
  box.innerHTML=_admUsers.map(u=>{
    const eAdmin=u.email.toLowerCase()===String(ADMIN_EMAIL).toLowerCase();
    return `<div class="ua-row">
      <span class="em">${esc(u.email)}${u.nome?' ('+esc(u.nome)+')':''}</span>
      ${eAdmin?`<div class="ua-ctrls">
            <span class="tagme">admin</span>
            ${curChk(u)}
            <select class="mini" title="Só para TI testares o que os outros planos veem — não muda o teu acesso real" onchange="iaTesteMudar(this.value)">
              ${IA_PLANOS.map(p=>`<option value="${p.v}"${(IA_TESTE||'premium')===p.v?' selected':''}>${p.r}</option>`).join('')}
            </select>
          </div>`
        :`<div class="ua-ctrls">
            <label class="chk" title="Tem garrafeira própria e pode mexer-lhe"><input type="checkbox"${u.pode_editar?' checked':''}
              onchange="admToggleEditor('${escJs(u.email)}',this.checked)"> Editor</label>
            ${curChk(u)}
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
async function admDefinirCurador(email,sim){
  try{
    await sbReq('POST','rpc/curador_definir',{p_email:email,p_sim:!!sim},{'Accept-Profile':'winecatalog','Content-Profile':'winecatalog'});
    if(email.toLowerCase()===String(EU.email).toLowerCase()){EU.curador=!!sim;fabSincronizar();}
    toast(sim?email+' passa a ser curador do catálogo':email+' deixa de ser curador do catálogo');
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
              '% Álc.','Preço','Beber','Onde está','Gar.'];
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
      <td class="pc">${precoPDF(v)}</td>
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
  .pfonte{display:block;font-size:8px;color:#8a7d78}
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
// Guarda as imagens já preparadas (encolhidas, em base64) para o "tenta com
// um modelo de IA diferente": só em memória do browser, nunca gravadas —
// serve só para não obrigar a escolher as fotos outra vez no mesmo ecrã.
let IMPORT_IMAGENS=[];

function importarAbrir(){
  if(roGuard())return;
  if(!podeUsarIA()){toast('A importação por IA não está incluída no teu acesso',1);return;}
  IMPORT_IMAGENS=[];
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
// Pedido à função, partilhado entre o envio normal e o "tenta com outro
// modelo" — só muda o corpo (`extra`), tudo o resto (erros, 404) é igual.
async function importarPedir(imagens,extra){
  const r=await sbFetch(SB_URL+'/functions/v1/importar-vinhos',{
    method:'POST',headers:{'Content-Type':'application/json','apikey':SB_KEY},
    body:JSON.stringify(Object.assign({garrafeiraId:GA_ID,imagens},extra||{}))
  });
  let d={};try{d=await r.json();}catch(_){}
  if(!r.ok){
    if(r.status===404)throw new Error('A função importar-vinhos ainda não está publicada no Supabase. Ver o README.');
    throw new Error(d.error||('O servidor respondeu HTTP '+r.status));
  }
  if(!d.id)throw new Error('A importação não devolveu identificador');
  return d.id;
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
    IMPORT_IMAGENS=imagens;
    estado.textContent='A enviar para leitura…';btn.textContent='A ler…';
    importarEspera(await importarPedir(imagens));
  }catch(e){
    estado.style.color='var(--dg)';estado.textContent='Não deu: '+e.message;
    btn.disabled=false;btn.textContent='Tentar outra vez';
  }
}
// Só para quem tem IA premium, e só depois de já se ter visto o resultado do
// modelo barato: um pedido explícito de "outro modelo", com as MESMAS
// imagens já preparadas — não obriga a escolher as fotos outra vez.
async function importarTentarOutroModelo(){
  if(!IMPORT_IMAGENS.length)return;
  document.getElementById('modal-ia-in').innerHTML=
    "<div class='mtop'><div><h3>📷 A tentar com outro modelo…</h3></div><button class='mx' onclick=\"fecharModal('modal-ia')\">✕</button></div>"+
    "<div class='note' id='imp-estado'>A reler as mesmas imagens com um modelo de IA diferente. Pode levar até dois minutos.</div>"+
    "<div class='macoes'><button class='btn ghost' id='imp-btn' disabled>A ler…</button></div>";
  try{
    importarEspera(await importarPedir(IMPORT_IMAGENS,{modelo:'grande'}));
  }catch(e){
    const estado=document.getElementById('imp-estado');
    if(estado){estado.style.color='var(--dg)';estado.textContent='Não deu: '+e.message;}
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
  // Só faz sentido oferecer "outro modelo" quando este resultado veio do
  // barato (o modelo grande já é a última carta) e há premium para o pagar.
  const outroModelo=(temPremium()&&IMPORT_IMAGENS.length&&/lite/.test(resultado.modelo||''))
    ?"<div class='note' style='margin-top:8px'>Não ficaste satisfeito? Tira uma fotografia mais nítida ou <a href='#' onclick='importarTentarOutroModelo();return false'>experimenta um modelo de IA diferente</a>.</div>":"";
  const linhas=IMPORT_RESULTADO.map((v,i)=>{
    const detalhes=[v.tipo,v.regiao,v.mencao,v.teor?v.teor+'%':'',(v.castas||[]).join(', ')].filter(Boolean).join(' · ');
    return "<div class='ia-linha' style='display:block'>"+
      "<div style='display:flex;gap:8px;align-items:center'><input type='checkbox' class='imp-sel' data-i='"+i+"' checked>"+
      "<div style='flex:1;min-width:0'><label style='margin-top:0'>Nome</label><input class='imp-nome' data-i='"+i+"' value='"+esc(capitalizarLivre(v.nome||""))+"'></div></div>"+
      "<div><label>Produtor</label><input class='imp-produtor' data-i='"+i+"' value='"+esc(capitalizarLivre(v.produtor||""))+"'></div>"+
      "<div class='mrow'><div><label>Ano</label><input class='imp-ano' data-i='"+i+"' inputmode='numeric' value='"+esc(v.ano||"")+"'></div><div><label>Garrafas</label><input class='imp-qtd' data-i='"+i+"' type='number' min='1' max='60' value='"+esc(v.quantidade||1)+"'></div><div><label>Formato</label><select class='imp-formato' data-i='"+i+"'>"+FORMATOS.map(function(x){return "<option value='"+esc(x)+"'>"+esc(x)+"</option>";}).join('')+"</select></div></div>"+
      (detalhes?"<div class='note' style='margin-top:6px'>"+esc(detalhes)+"</div>":"")+
      (v.aviso?"<div class='note' style='margin-top:4px'>⚠️ "+esc(v.aviso)+"</div>":"")+"</div>";
  }).join('');
  document.getElementById('modal-ia-in').innerHTML=
    "<div class='mtop'><div><h3>Rever antes de importar</h3><div class='note' style='margin-top:3px'>"+IMPORT_RESULTADO.length+" vinho(s) proposto(s). Edita nome, produtor, ano ou quantidade antes de adicionar.</div></div><button class='mx' onclick=\"fecharModal('modal-ia')\">✕</button></div>"+
    aviso+outroModelo+(linhas||"<div class='note' style='margin-top:14px'>Não foi possível identificar nenhum vinho com segurança. Tenta fotos mais nítidas ou uma imagem de cada vez.</div>")+
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
  let feitos=0;const novos=[];
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
      feitos++;novos.push(vinhoId);
    }
    await carregarGarrafeira();await recarregarCastas();renderLista();fecharModal('modal-ia');
    toast(feitos+' vinho(s) e respetivas garrafas adicionados ✓');
    await oferecerRetirarDesejos(novos.map(id=>IDXV[id]));
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
/* Que sites deixam a vinho-info ler as páginas (60 dias, migração 30): é o
   que diz se um site vale a pena ser proposto no "Procurar links". Não lida
   = recusou, veio vazia ou não respondeu a tempo — o efeito é o mesmo. */
async function diagSitesHTML(){
  let rows;
  try{rows=await sbRpc('paginas_por_site',{p_dias:60});}catch(e){return '';}
  if(!Array.isArray(rows)||!rows.length)return '<div class="diag-l"><b>Páginas por site (60 dias)</b><div class="note">Ainda nenhuma página aberta.</div></div>';
  return `<div class="diag-l"><b>Páginas por site (60 dias)</b>${rows.map(r=>
    `<div class="note">${esc(r.site)}: lidas <b>${r.lidas}</b> de ${r.tentativas}${r.lidas<r.tentativas&&r.motivo?` · ${esc(r.motivo)}`:''}</div>`).join('')}</div>`;
}
async function renderDiag(){
  const box=document.getElementById('diag-box');
  box.innerHTML='<div class="note">A ler…</div>';
  try{
    const l=await sbReq('GET','sync_log?select=*&order=criado_em.desc&limit=25');
    if(!l||!l.length){box.innerHTML='<div class="note">Sem registos ainda.</div>';return;}
    const sites=await diagSitesHTML();
    box.innerHTML=sites+l.map(r=>`<div class="diag-l">
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

/* O HTML E O JS TÊM DE SER DA MESMA VERSÃO — e quando não são, não pode ser
   em silêncio. Os três ficheiros são network-first no `sw.js` precisamente
   para andarem juntos, mas isso só manda no browser: o CDN do GitHub Pages
   propaga-os um de cada vez, e há uma janela de segundos a seguir a um
   deploy em que se apanha o `index.html` NOVO com o `app.js` VELHO (ou o
   contrário, de uma cache de HTTP qualquer pelo caminho). O que se vê então
   é a pior avaria que esta app tem: botões novos a chamar funções que ainda
   não existem, sem um erro no ecrã — "carrego nos filtros e não acontece
   nada". Já aconteceu aqui e já tinha acontecido no Goals.
   O `data-build` do <body>, o `APP_BUILD` daqui e o `CACHE_NAME` do `sw.js`
   são O MESMO NÚMERO e sobem os três no mesmo commit. Se discordarem,
   recarrega-se UMA vez — a janela é de segundos, e uma recarga costuma
   bastar — e o `sessionStorage` é o que impede o ciclo infinito se a
   discordância for permanente. À segunda, diz-se o que se passa com um
   botão a fazer o que falta, que é sempre melhor do que fingir que está
   tudo bem. */
const APP_BUILD='148';
(function verificarBuild(){
  const doHtml=document.body.getAttribute('data-build');
  if(doHtml===APP_BUILD)return;
  let jaTentou=false;
  try{jaTentou=sessionStorage.getItem('gf_build')===APP_BUILD;}catch(e){}
  if(!jaTentou){
    try{sessionStorage.setItem('gf_build',APP_BUILD);}catch(e){}
    location.reload();
    return;
  }
  // Estilo à mão e não uma classe: o `style.css` pode ser o velho, e esta é
  // precisamente a mensagem que não pode depender de mais nada para
  // aparecer.
  const b=document.createElement('div');
  b.style.cssText='position:fixed;left:0;right:0;top:0;z-index:99999;padding:12px 14px;'+
    'background:#7b1f3d;color:#fff;font:14px/1.4 system-ui,sans-serif;text-align:center';
  b.innerHTML='A app ficou a meio de uma atualização e alguns botões não '+
    'respondem. <button style="margin-left:8px;padding:6px 12px;border:0;border-radius:99px;'+
    'background:#fff;color:#7b1f3d;font:inherit;font-weight:700;cursor:pointer">Atualizar</button>';
  b.querySelector('button').onclick=()=>{
    try{sessionStorage.removeItem('gf_build');}catch(e){}
    if('serviceWorker' in navigator&&navigator.serviceWorker.getRegistrations)
      navigator.serviceWorker.getRegistrations()
        .then(rs=>Promise.all(rs.map(r=>r.unregister())))
        .catch(()=>{})
        .then(()=>location.reload());
    else location.reload();
  };
  document.body.appendChild(b);
})();
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
  // O comentário abre por cima da página do vinho: sai só ele.
  if(e.key==='Escape'&&document.getElementById('modal-comentario').classList.contains('on')){fecharModal('modal-comentario');return;}
  if(e.key==='Escape')document.querySelectorAll('.modal.on').forEach(m=>fecharModal(m.id));
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
// Começa fechado e só abre quando `carregar()` souber quem é quem. Ao
// contrário, havia um instante — entre o HTML aparecer e as permissões
// chegarem — em que quem só pode VER tinha o botão de apagar à frente.
document.body.classList.add('readonly','naoadmin','naodono','naominha');
detVistaBotoes();
// O andar guardado tem de chegar ao DOM antes de o `carregar()` responder:
// o HTML nasce fechado, e quem tinha deixado a barra aberta no andar 3 via-a
// a fechar-se e a abrir-se outra vez assim que os dados chegavam.
document.getElementById('filtros').classList.toggle('aberto',FILTROS_ABERTO);
ajustarSticky();
pgSwipe();
sbInit();
