-- =====================================================================
-- Garrafeira — RLS Policies (schema `garrafeira`)
--
-- PRÉ-REQUISITO: depende das funções em functions.sql —
--   garrafeira.is_admin(), is_allowed(), is_editor()
-- Correr functions.sql ANTES deste ficheiro.
--
-- Ordem geral: schema.sql -> functions.sql -> policies.sql
--
-- A REGRA, em três níveis MAIS a garrafeira de cada um:
--   · is_allowed()  entra na app
--   · is_editor()   escreve  (admin + quem tiver pode_editar)
--   · is_admin()    manda em quem tem acesso e em quem é editor
--   · pode_ver(g)   vê a garrafeira `g`      — é dono dela, ou foi-lhe emprestada
--   · pode_mexer(g) escreve na garrafeira `g` — is_editor() E é dono dela
--
-- `is_allowed()` deixou de chegar para ver um vinho: diz que a pessoa entra
-- na app, não de quem são as garrafas. Todas as tabelas com conteúdo
-- (`locais`, `vinhos`, `garrafas`, e por arrasto `vinho_castas`) andam
-- agora por `pode_ver`/`pode_mexer`, e é isso que faz com que o João nunca
-- veja uma linha da garrafeira do Barrona enquanto ele não lha emprestar.
--
-- Emprestada por `partilhas` é SÓ PARA VER: `pode_mexer` nunca dá verdadeiro
-- por causa de uma partilha, e por isso não há caminho nenhum — nem por
-- engano nem à força — para escrever numa garrafeira que te emprestaram. A
-- app esconde os botões (`body.readonly`), mas quem recusa é isto.
--
-- A ÚNICA exceção é o admin da app, e só quando o dono lha deu: a coluna
-- `garrafeiras.admin_acesso` ('nenhuma' por defeito, 'leitura', 'edicao').
-- `is_admin()` sozinho não abre nada. Ver a nota em functions.sql.
--
-- Nada aqui é legível pelo role `anon`: todas as policies são
-- `TO authenticated`. Não há modo convidado nesta app — uma garrafeira de
-- casa diz onde estão garrafas caras dentro da casa de alguém, o que é
-- diferente do calendário de jogos do Goals.
-- =====================================================================

-- ---------------------------------------------------------------------
-- garrafeiras — a lista que a app mostra no seletor de Definições
-- ---------------------------------------------------------------------
-- Aqui as condições são escritas À MÃO (`lower(dono) = lower(auth.email())`)
-- em vez de chamarem `garrafeira.e_dono()`: a função lê ESTA tabela, e uma
-- policy da tabela X que chama uma função que lê a tabela X é o caminho
-- curto para a recursão. Nas outras tabelas já não há esse problema — elas
-- leem `garrafeiras` de fora.
-- A condição do admin lê a coluna DIRETAMENTE em vez de chamar
-- `garrafeira.admin_acesso(id)`: essa função passa pelo `e_dono()`, que lê
-- outra vez esta mesma tabela. Aqui, na policy dela, escreve-se à mão.
DROP POLICY IF EXISTS g_sel ON garrafeira.garrafeiras;
CREATE POLICY g_sel ON garrafeira.garrafeiras
  FOR SELECT TO authenticated
  USING (lower(dono) = lower(auth.email())
      OR garrafeira.tem_partilha(id)
      OR (garrafeira.is_admin() AND admin_acesso <> 'nenhuma'));

-- Criar a sua: a app não faz isto por POST (usa `garantir_garrafeira()`,
-- que garante que não há duas), mas quem quiser uma segunda garrafeira
-- ("a da casa da praia") cria-a por aqui. Sempre em nome próprio.
DROP POLICY IF EXISTS g_ins ON garrafeira.garrafeiras;
CREATE POLICY g_ins ON garrafeira.garrafeiras
  FOR INSERT TO authenticated
  WITH CHECK (garrafeira.is_editor() AND lower(dono) = lower(auth.email()));

-- Mudar o nome e o `admin_acesso`, sim. Mudar o DONO, não: o `WITH CHECK`
-- obriga a linha a continuar minha depois do UPDATE, e por isso passar a
-- garrafeira a outra pessoa só se faz por `transferir_garrafeira()` — que
-- verifica que ela já pode editar na app antes de lha entregar.
--
-- Só o DONO, note-se — nem o admin com 'edicao'. Ele mexe nas GARRAFAS que
-- lhe abriram, não na fechadura: dar-lhe este UPDATE era deixá-lo subir-se
-- de 'leitura' a 'edicao' sozinho, e a permissão deixava de ser de quem a
-- dá.
DROP POLICY IF EXISTS g_upd ON garrafeira.garrafeiras;
CREATE POLICY g_upd ON garrafeira.garrafeiras
  FOR UPDATE TO authenticated
  USING (lower(dono) = lower(auth.email()))
  WITH CHECK (lower(dono) = lower(auth.email()));

DROP POLICY IF EXISTS g_del ON garrafeira.garrafeiras;
CREATE POLICY g_del ON garrafeira.garrafeiras
  FOR DELETE TO authenticated
  USING (lower(dono) = lower(auth.email()));

-- ---------------------------------------------------------------------
-- partilhas — quem mais vê a minha garrafeira
-- ---------------------------------------------------------------------
-- O dono vê (e mexe) na lista da SUA garrafeira; quem recebeu vê a própria
-- linha e pode apagá-la — devolver uma garrafeira emprestada não tem de
-- passar por pedir ao dono.
DROP POLICY IF EXISTS p_sel ON garrafeira.partilhas;
CREATE POLICY p_sel ON garrafeira.partilhas
  FOR SELECT TO authenticated
  USING (garrafeira.e_dono(garrafeira_id) OR lower(email) = lower(auth.email()));

DROP POLICY IF EXISTS p_ins ON garrafeira.partilhas;
CREATE POLICY p_ins ON garrafeira.partilhas
  FOR INSERT TO authenticated
  WITH CHECK (garrafeira.e_dono(garrafeira_id));

DROP POLICY IF EXISTS p_del ON garrafeira.partilhas;
CREATE POLICY p_del ON garrafeira.partilhas
  FOR DELETE TO authenticated
  USING (garrafeira.e_dono(garrafeira_id) OR lower(email) = lower(auth.email()));

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
  FOR SELECT TO authenticated USING (garrafeira.pode_ver(garrafeira_id));
DROP POLICY IF EXISTS locais_edit ON garrafeira.locais;
CREATE POLICY locais_edit ON garrafeira.locais
  FOR ALL TO authenticated
  USING (garrafeira.pode_mexer(garrafeira_id)) WITH CHECK (garrafeira.pode_mexer(garrafeira_id));

DROP POLICY IF EXISTS vinhos_sel ON garrafeira.vinhos;
CREATE POLICY vinhos_sel ON garrafeira.vinhos
  FOR SELECT TO authenticated USING (garrafeira.pode_ver(garrafeira_id));
-- O `USING` e o `WITH CHECK` são a mesma condição mas não a mesma pergunta:
-- o primeiro é sobre a linha COMO ESTÁ (posso mexer nesta?), o segundo sobre
-- a linha COMO FICA (posso deixá-la assim?). Iguais, um UPDATE que troque o
-- `garrafeira_id` só passa se as DUAS garrafeiras forem minhas — que é o
-- que se quer: mover um vinho entre garrafeiras minhas pode; empurrá-lo
-- para a de outra pessoa, não.
DROP POLICY IF EXISTS vinhos_edit ON garrafeira.vinhos;
CREATE POLICY vinhos_edit ON garrafeira.vinhos
  FOR ALL TO authenticated
  USING (garrafeira.pode_mexer(garrafeira_id)) WITH CHECK (garrafeira.pode_mexer(garrafeira_id));

-- As CASTAS ficam globais, e é de propósito: "Touriga Nacional" é o mesmo
-- nome na garrafeira de toda a gente, e é essa tabela única que faz a
-- procura por casta funcionar (ver a nota em schema.sql sobre as duas
-- grafias de "Alicante Bouschet"). Não há aqui nada de privado: o que liga
-- uma casta a um vinho é `vinho_castas`, e ESSA anda pela garrafeira do
-- vinho, logo abaixo.
-- Apagar, porém, passou a ser só do admin: uma casta que o João apagasse
-- levava atrás as linhas de `vinho_castas` do Barrona (ON DELETE CASCADE) e
-- o Barrona via os seus vinhos a perderem as castas sem ninguém lhes ter
-- tocado. A app nunca apaga castas — isto é a rede.
DROP POLICY IF EXISTS castas_sel ON garrafeira.castas;
CREATE POLICY castas_sel ON garrafeira.castas
  FOR SELECT TO authenticated USING (garrafeira.is_allowed());
DROP POLICY IF EXISTS castas_edit ON garrafeira.castas;
DROP POLICY IF EXISTS castas_ins ON garrafeira.castas;
CREATE POLICY castas_ins ON garrafeira.castas
  FOR INSERT TO authenticated WITH CHECK (garrafeira.is_editor());
DROP POLICY IF EXISTS castas_upd ON garrafeira.castas;
CREATE POLICY castas_upd ON garrafeira.castas
  FOR UPDATE TO authenticated
  USING (garrafeira.is_editor()) WITH CHECK (garrafeira.is_editor());
DROP POLICY IF EXISTS castas_del ON garrafeira.castas;
CREATE POLICY castas_del ON garrafeira.castas
  FOR DELETE TO authenticated USING (garrafeira.is_admin());

-- `vinho_castas` não tem `garrafeira_id` próprio — é a única tabela de
-- conteúdo que não tem, e não é esquecimento: a linha é a ponte entre um
-- vinho e uma casta, e a garrafeira dela é sempre a do vinho. Uma coluna
-- repetida aqui era mais uma coisa para ficar dessincronizada; a função vai
-- buscá-la ao vinho.
DROP POLICY IF EXISTS vinho_castas_sel ON garrafeira.vinho_castas;
CREATE POLICY vinho_castas_sel ON garrafeira.vinho_castas
  FOR SELECT TO authenticated
  USING (garrafeira.pode_ver(garrafeira.garrafeira_do_vinho(vinho_id)));
DROP POLICY IF EXISTS vinho_castas_edit ON garrafeira.vinho_castas;
CREATE POLICY vinho_castas_edit ON garrafeira.vinho_castas
  FOR ALL TO authenticated
  USING (garrafeira.pode_mexer(garrafeira.garrafeira_do_vinho(vinho_id)))
  WITH CHECK (garrafeira.pode_mexer(garrafeira.garrafeira_do_vinho(vinho_id)));

-- O `garrafeira_id` das garrafas nunca vem do cliente: o trigger
-- `garrafas_guard` copia-o do vinho antes de a policy o ler (os BEFORE
-- triggers correm primeiro, o WITH CHECK depois). É por isso que não é
-- preciso desconfiar dele aqui.
DROP POLICY IF EXISTS garrafas_sel ON garrafeira.garrafas;
CREATE POLICY garrafas_sel ON garrafeira.garrafas
  FOR SELECT TO authenticated USING (garrafeira.pode_ver(garrafeira_id));
DROP POLICY IF EXISTS garrafas_edit ON garrafeira.garrafas;
CREATE POLICY garrafas_edit ON garrafeira.garrafas
  FOR ALL TO authenticated
  USING (garrafeira.pode_mexer(garrafeira_id)) WITH CHECK (garrafeira.pode_mexer(garrafeira_id));

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

-- A procura à IA é uma chamada PAGA ao Gemini. Pedi-la para um vinho que
-- não é meu não dava para gravar nada (o PATCH ao vinho seria recusado),
-- mas gastava dinheiro à mesma — por isso pára aqui. O `vinho_id` nulo é o
-- formulário de vinho novo, que ainda não tem vinho a que pertencer.
DROP POLICY IF EXISTS analises_ins ON garrafeira.analises;
CREATE POLICY analises_ins ON garrafeira.analises
  FOR INSERT TO authenticated
  WITH CHECK (garrafeira.is_editor() AND (
    vinho_id IS NULL OR garrafeira.pode_mexer(garrafeira.garrafeira_do_vinho(vinho_id))));

DROP POLICY IF EXISTS analises_del ON garrafeira.analises;
CREATE POLICY analises_del ON garrafeira.analises
  FOR DELETE TO authenticated
  USING (garrafeira.is_admin() OR lower(quem) = lower(auth.email()));

-- ---------------------------------------------------------------------
-- importacoes — tal como as análises, só quem a pediu (ou o admin) vê o
-- resultado. A inserção confirma que pode mexer na garrafeira escolhida;
-- o fecho corre na Edge Function com a service role.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS importacoes_sel ON garrafeira.importacoes;
CREATE POLICY importacoes_sel ON garrafeira.importacoes
  FOR SELECT TO authenticated
  USING (garrafeira.is_admin() OR lower(quem) = lower(auth.email()));

DROP POLICY IF EXISTS importacoes_ins ON garrafeira.importacoes;
CREATE POLICY importacoes_ins ON garrafeira.importacoes
  FOR INSERT TO authenticated
  WITH CHECK (garrafeira.is_editor() AND garrafeira.pode_mexer(garrafeira_id));

DROP POLICY IF EXISTS importacoes_del ON garrafeira.importacoes;
CREATE POLICY importacoes_del ON garrafeira.importacoes
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

-- ---------------------------------------------------------------------
-- storage.objects — as fotos dos rótulos (bucket `garrafeira-rotulos`)
-- ---------------------------------------------------------------------
-- As mesmas fronteiras do resto da app, e pela mesma garrafeira: o caminho
-- de cada ficheiro é `v<id-do-vinho>/…`, e é daí que `foto_visivel()` e
-- `foto_minha()` chegam ao vinho e à garrafeira dele (ver functions.sql).
-- Antes bastava `is_allowed()` — uma foto do rótulo é tirada em casa e
-- apanha a prateleira à volta, por isso não pode ficar à distância de um
-- caminho adivinhado por quem tem conta na app mas não tem esta garrafeira.
--
-- Todas as policies são presas ao `bucket_id` — sem isso davam acesso aos
-- buckets de TODAS as outras apps deste projeto Supabase.
DROP POLICY IF EXISTS garrafeira_rotulos_sel ON storage.objects;
CREATE POLICY garrafeira_rotulos_sel ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'garrafeira-rotulos' AND garrafeira.foto_visivel(name));

DROP POLICY IF EXISTS garrafeira_rotulos_ins ON storage.objects;
CREATE POLICY garrafeira_rotulos_ins ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'garrafeira-rotulos' AND garrafeira.foto_minha(name));

DROP POLICY IF EXISTS garrafeira_rotulos_upd ON storage.objects;
CREATE POLICY garrafeira_rotulos_upd ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'garrafeira-rotulos' AND garrafeira.foto_minha(name))
  WITH CHECK (bucket_id = 'garrafeira-rotulos' AND garrafeira.foto_minha(name));

DROP POLICY IF EXISTS garrafeira_rotulos_del ON storage.objects;
CREATE POLICY garrafeira_rotulos_del ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'garrafeira-rotulos' AND garrafeira.foto_minha(name));
