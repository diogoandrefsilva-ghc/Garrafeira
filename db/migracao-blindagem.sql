-- ---------------------------------------------------------------------
-- Migração 13 — blindagem: o que o linter do Supabase apanhou
--
-- Correr DEPOIS do `catalogo-partilhado.sql`. É toda idempotente e não
-- muda comportamento nenhum da app: só fecha caminhos que estavam abertos
-- e não deviam estar.
--
-- O que NÃO está aqui, e porquê — para ninguém o vir "corrigir" depois:
--
--  · os avisos de `SECURITY DEFINER` executável por `anon`/`authenticated`
--    em `is_allowed`, `is_editor`, `pode_ver`, `pode_mexer`, `plano_ia`,
--    `admin_email`, `e_dono`, `tem_partilha`, `garantir_garrafeira`,
--    `definir_admin`, `transferir_garrafeira`, `admin_pass_temp`,
--    `foto_visivel`, `foto_minha`. **A app chama-as do browser** — é assim
--    que ela funciona — e as que fazem alguma coisa perigosa defendem-se
--    por dentro (`is_admin()`, `e_dono()`, `is_editor()`, e todas com o
--    `search_path` fixo). Revogar era partir a app para fechar uma porta
--    que já tem fechadura;
--
--  · `catalogar_vinho` continua executável pelo `authenticated`, e tem de
--    continuar: a `definir_castas` é SECURITY INVOKER e chama-a lá dentro.
--    Sem o EXECUTE, essa chamada rebentava — e como está dentro de um
--    `EXCEPTION WHEN OTHERS THEN NULL`, rebentava EM SILÊNCIO: o catálogo
--    deixava de ser alimentado quando alguém mudasse as castas de um
--    vinho, e ninguém dava por nada. Tirar-lhe só o `anon`, que nunca a
--    chama por caminho nenhum.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. As tabelas de backup estavam ABERTAS
--
-- `_backup_vinhos_20260901` (85 vinhos) e `_backup_vinho_castas_20260901`
-- (79 ligações) ficaram da migração das garrafeiras, com RLS DESLIGADA num
-- schema EXPOSTO na API. Ou seja: qualquer pessoa com a chave `anon` (que é
-- pública por design, está no topo do `app.js`) lia os vinhos de toda a
-- gente sem sequer ter login. O "cada um vê a sua garrafeira" tinha uma
-- porta das traseiras de setembro.
--
-- Liga-se a RLS e NÃO se cria policy nenhuma: são backups, ninguém os lê
-- pela API. O `service_role` e o dono da base continuam a chegar-lhes, que
-- é para isso que um backup serve.
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS garrafeira._backup_vinhos_20260901       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS garrafeira._backup_vinho_castas_20260901 ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2. As funções de TRIGGER não são para ser chamadas por ninguém
--
-- O PostgREST publica-as em `/rest/v1/rpc/<nome>` como qualquer outra. Não
-- chegam a fazer nada (o Postgres recusa chamar uma função de trigger fora
-- de um trigger), mas o EXECUTE não lhes serve de nada e o que não serve
-- fecha-se.
--
-- Revogar NÃO parte os triggers: o Postgres verifica o EXECUTE quando o
-- trigger é CRIADO, não de cada vez que dispara.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION garrafeira.analises_guard_ins()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.ar_guard_ins()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.garrafas_guard()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.importacoes_guard_ins()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.partilhas_guard_ins()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.vinhos_catalogo()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.vinhos_guard_ins()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wineselection.analises_guard_ins()  FROM PUBLIC, anon, authenticated;

-- Ver a nota lá em cima: só o `anon`.
REVOKE ALL ON FUNCTION garrafeira.catalogar_vinho(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogar_vinho(bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. `search_path` fixo nas funções do catálogo e nas duas da WineSelection
--
-- Uma função sem `search_path` resolve os nomes com o do CALLER. Nestas o
-- risco é pequeno (nenhuma é SECURITY DEFINER, e tudo o que interessa já
-- vai qualificado), mas é a mesma regra que TODAS as funções da Garrafeira
-- já cumprem — e uma regra que vale para umas e não para outras é uma
-- regra que um dia se esquece na que importa.
--
-- As da WineSelection são mais uma daquelas em que a lição ficou só de um
-- lado: as equivalentes da Garrafeira (`is_admin`, `is_allowed`) têm o
-- `search_path` desde sempre.
--
-- Nota: uma função SQL com `SET` deixa de poder ser "inlined" pelo
-- planeador. Aqui não custa nada — são tabelas de centenas de linhas e
-- nenhum índice depende destas funções.
-- ---------------------------------------------------------------------
ALTER FUNCTION catalogo.tokens(text)                  SET search_path TO 'catalogo', 'public';
ALTER FUNCTION catalogo.chave_base(text, text)        SET search_path TO 'catalogo', 'public';
ALTER FUNCTION catalogo.chave(text, text, integer)    SET search_path TO 'catalogo', 'public';
ALTER FUNCTION catalogo.base_nome(text)               SET search_path TO 'catalogo', 'public';
ALTER FUNCTION catalogo.chave_nome(text, integer)     SET search_path TO 'catalogo', 'public';
ALTER FUNCTION catalogo.volatil(text)                 SET search_path TO 'catalogo', 'public';
ALTER FUNCTION catalogo.forca(text, text)             SET search_path TO 'catalogo', 'public';

ALTER FUNCTION wineselection.is_admin()   SET search_path TO 'wineselection', 'public';
ALTER FUNCTION wineselection.is_allowed() SET search_path TO 'wineselection', 'public';
