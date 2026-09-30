-- =====================================================================
-- Migração 36 — trocar a imagem de um vinho do CATÁLOGO pela app
-- (30/09/2026, o dono: "quando fazemos zoom à imagem do vinho, temos que
-- ter lá um botão de alterar imagem, que me deixa importar do telemóvel")
--
-- Num vinho da garrafeira o botão já existia (a minha fotografia, no bucket
-- privado `garrafeira-rotulos`). Num vinho do catálogo não havia nenhum: a
-- imagem do catálogo é a de toda a gente, e não pode ir para o bucket
-- privado de uma garrafeira. Vai para o bucket PÚBLICO das imagens das
-- lojas (`garrafeira-imagens`, migração 34), na pasta `cat/`, e a linha do
-- catálogo passa a apontar para lá pela `winecatalog.editar` de sempre.
--
-- Quem pode: só quem já corrige o catálogo — os curadores e o admin do
-- catálogo (o mesmo `catPodeCriar` da app). Só ENVIAR, e só para `cat/`:
-- ninguém apaga nem reescreve por aqui. A anterior não se apaga — pode ser
-- a mesma cópia que as garrafeiras ainda usam.
-- =====================================================================

DROP POLICY IF EXISTS "garrafeira imagens: curador envia" ON storage.objects;
CREATE POLICY "garrafeira imagens: curador envia" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'garrafeira-imagens'
              AND name LIKE 'cat/%'
              AND (winecatalog.sou_curador() OR winecatalog.sou_admin()));
