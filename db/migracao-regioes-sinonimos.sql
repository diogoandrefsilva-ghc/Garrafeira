-- ════════════════════════════════════════════════════════════════════
-- Migração 37 — as regiões escritas com um sinónimo (30/09/2026)
-- ════════════════════════════════════════════════════════════════════
-- "Alentejano" (o Vinho Regional), "Évora" (uma sub-região), "Evoramonte"
-- (uma terra), "Terras do Sado" (o Vinho Regional de Setúbal) estavam
-- gravados como REGIÃO, e cada um era uma faceta própria nos filtros ao
-- lado de "Alentejo" e "Setúbal". A regra que os passa à região a sério é
-- do catálogo (`db/regioes.sql` do WineCatalog, que corre ANTES desta);
-- o trigger `vinhos_normalizar_regiao` (`db/migracao-regiao.sql`) aplica-a
-- a cada escrita e passa a sub-região que o valor trazia para a
-- `sub_regiao`, se estiver vazia.
--
-- Isto corrige o que já estava escrito: tocar na `regiao` chega para o
-- trigger fazer o resto. Com a marca `garrafeira.do_catalogo`, como as
-- escritas que vêm do catálogo — é arrumação, não é o dono a gravar: não
-- volta ao catálogo (que o `regioes.sql` já corrigiu) e não carimba
-- `atualizado_em`.
--
-- "Beiras" é ambíguo e fica fora da regra; com a sub-região escrita deixa
-- de o ser (Silgueiros é Dão; "Bairrada" é a própria região).
--
-- Idempotente.
-- ---------------------------------------------------------------------
BEGIN;
SELECT set_config('garrafeira.do_catalogo', 'sim', true);

UPDATE garrafeira.vinhos
   SET regiao = regiao
 WHERE regiao IS DISTINCT FROM COALESCE(winecatalog.normalizar_regiao(regiao), '')
    OR (winecatalog.subregiao_de(regiao) IS NOT NULL AND btrim(sub_regiao) = '');

UPDATE garrafeira.vinhos
   SET regiao = 'Dão'
 WHERE regiao = 'Beiras'
   AND sub_regiao IN ('Silgueiros', 'Alva', 'Besteiros', 'Castendo',
                      'Serra da Estrela', 'Terras de Azurara', 'Terras de Senhorim');

UPDATE garrafeira.vinhos
   SET regiao = 'Bairrada', sub_regiao = ''
 WHERE regiao = 'Beiras'
   AND sub_regiao = 'Bairrada';

COMMIT;
