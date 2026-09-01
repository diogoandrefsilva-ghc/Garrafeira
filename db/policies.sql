-- =====================================================================
-- Garrafeira — RLS Policies (schema `garrafeira`)
--
-- PRÉ-REQUISITO: depende das funções em functions.sql —
--   garrafeira.is_admin(), is_allowed(), is_editor()
-- Correr functions.sql ANTES deste ficheiro.
--
-- Ordem geral: schema.sql -> functions.sql -> policies.sql
--
-- A REGRA, em três níveis:
--   · is_allowed()  vê tudo o que é a garrafeira (vinhos, garrafas, locais,
--                   castas, histórico de consumos)
--   · is_editor()   escreve nisso
--   · is_admin()    manda em quem tem acesso e em quem é editor
--
-- Nada aqui é legível pelo role `anon`: todas as policies são
-- `TO authenticated`. Não há modo convidado nesta app — uma garrafeira de
-- casa diz onde estão garrafas caras dentro da casa de alguém, o que é
-- diferente do calendário de jogos do Goals.
-- =====================================================================

-- ---------------------------------------------------------------------
-- access_requests
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS ar_insert ON garrafeira.access_requests;
CREATE POLICY ar_insert ON garrafeira.access_requests
  FOR INSERT TO authenticated
  WITH CHECK (lower(email) = lower(auth.email()));

DROP POLICY IF EXISTS ar_admin_sel ON garrafeira.access_requests;
CREATE POLICY ar_admin_sel ON garrafeira.access_requests
  FOR SELECT TO authenticated
  USING (garrafeira.is_admin());

DROP POLICY IF EXISTS ar_admin_del ON garrafeira.access_requests;
CREATE POLICY ar_admin_del ON garrafeira.access_requests
  FOR DELETE TO authenticated
  USING (garrafeira.is_admin());

-- ---------------------------------------------------------------------
-- allowed_users — cada um vê a sua linha (é assim que a app sabe se pode
-- editar); só o admin escreve.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS au_sel ON garrafeira.allowed_users;
CREATE POLICY au_sel ON garrafeira.allowed_users
  FOR SELECT TO authenticated
  USING (lower(email) = lower(auth.email()) OR garrafeira.is_admin());

DROP POLICY IF EXISTS au_admin ON garrafeira.allowed_users;
CREATE POLICY au_admin ON garrafeira.allowed_users
  FOR ALL TO authenticated
  USING (garrafeira.is_admin())
  WITH CHECK (garrafeira.is_admin());

-- ---------------------------------------------------------------------
-- config — leitura para quem tem acesso (a app precisa de saber o
-- admin_email para mostrar os botões certos); escrita por NINGUÉM.
-- Não é esquecimento: a única chave que lá está a sério é `admin_email`, e
-- trocá-la é passar a app a outra pessoa. Essa passagem tem regras (o novo
-- dono tem de já ter acesso) que um UPDATE solto não consegue impor — por
-- isso a porta é a função garrafeira.definir_admin(), e só ela.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS cfg_sel ON garrafeira.config;
CREATE POLICY cfg_sel ON garrafeira.config
  FOR SELECT TO authenticated
  USING (garrafeira.is_allowed());

-- ---------------------------------------------------------------------
-- locais / vinhos / castas / vinho_castas / garrafas
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS locais_sel ON garrafeira.locais;
CREATE POLICY locais_sel ON garrafeira.locais
  FOR SELECT TO authenticated USING (garrafeira.is_allowed());
DROP POLICY IF EXISTS locais_edit ON garrafeira.locais;
CREATE POLICY locais_edit ON garrafeira.locais
  FOR ALL TO authenticated
  USING (garrafeira.is_editor()) WITH CHECK (garrafeira.is_editor());

DROP POLICY IF EXISTS vinhos_sel ON garrafeira.vinhos;
CREATE POLICY vinhos_sel ON garrafeira.vinhos
  FOR SELECT TO authenticated USING (garrafeira.is_allowed());
DROP POLICY IF EXISTS vinhos_edit ON garrafeira.vinhos;
CREATE POLICY vinhos_edit ON garrafeira.vinhos
  FOR ALL TO authenticated
  USING (garrafeira.is_editor()) WITH CHECK (garrafeira.is_editor());

DROP POLICY IF EXISTS castas_sel ON garrafeira.castas;
CREATE POLICY castas_sel ON garrafeira.castas
  FOR SELECT TO authenticated USING (garrafeira.is_allowed());
DROP POLICY IF EXISTS castas_edit ON garrafeira.castas;
CREATE POLICY castas_edit ON garrafeira.castas
  FOR ALL TO authenticated
  USING (garrafeira.is_editor()) WITH CHECK (garrafeira.is_editor());

DROP POLICY IF EXISTS vinho_castas_sel ON garrafeira.vinho_castas;
CREATE POLICY vinho_castas_sel ON garrafeira.vinho_castas
  FOR SELECT TO authenticated USING (garrafeira.is_allowed());
DROP POLICY IF EXISTS vinho_castas_edit ON garrafeira.vinho_castas;
CREATE POLICY vinho_castas_edit ON garrafeira.vinho_castas
  FOR ALL TO authenticated
  USING (garrafeira.is_editor()) WITH CHECK (garrafeira.is_editor());

DROP POLICY IF EXISTS garrafas_sel ON garrafeira.garrafas;
CREATE POLICY garrafas_sel ON garrafeira.garrafas
  FOR SELECT TO authenticated USING (garrafeira.is_allowed());
DROP POLICY IF EXISTS garrafas_edit ON garrafeira.garrafas;
CREATE POLICY garrafas_edit ON garrafeira.garrafas
  FOR ALL TO authenticated
  USING (garrafeira.is_editor()) WITH CHECK (garrafeira.is_editor());

-- ---------------------------------------------------------------------
-- analises — a procura à IA é de quem a pediu.
-- Não há policy de UPDATE de propósito: quem fecha a linha é a Edge
-- Function com a SERVICE ROLE, porque nessa altura (segundo plano) o JWT
-- de quem carregou já não existe.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS analises_sel ON garrafeira.analises;
CREATE POLICY analises_sel ON garrafeira.analises
  FOR SELECT TO authenticated
  USING (garrafeira.is_admin() OR lower(quem) = lower(auth.email()));

DROP POLICY IF EXISTS analises_ins ON garrafeira.analises;
CREATE POLICY analises_ins ON garrafeira.analises
  FOR INSERT TO authenticated
  WITH CHECK (garrafeira.is_editor());

DROP POLICY IF EXISTS analises_del ON garrafeira.analises;
CREATE POLICY analises_del ON garrafeira.analises
  FOR DELETE TO authenticated
  USING (garrafeira.is_admin() OR lower(quem) = lower(auth.email()));

-- ---------------------------------------------------------------------
-- sync_log — a app escreve o "pedido" antes de chamar (é assim que se
-- apanha o caso em que nem saiu do browser); a Edge Function escreve o
-- resto com a service role. Ler é só do admin: é diagnóstico, não é
-- conteúdo da app.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS sync_log_sel ON garrafeira.sync_log;
CREATE POLICY sync_log_sel ON garrafeira.sync_log
  FOR SELECT TO authenticated USING (garrafeira.is_admin());

DROP POLICY IF EXISTS sync_log_ins ON garrafeira.sync_log;
CREATE POLICY sync_log_ins ON garrafeira.sync_log
  FOR INSERT TO authenticated WITH CHECK (garrafeira.is_allowed());

DROP POLICY IF EXISTS sync_log_del ON garrafeira.sync_log;
CREATE POLICY sync_log_del ON garrafeira.sync_log
  FOR DELETE TO authenticated USING (garrafeira.is_admin());
