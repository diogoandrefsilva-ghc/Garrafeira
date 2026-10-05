-- ════════════════════════════════════════════════════════════════════════
-- Migração 44 — a Real Companhia Velha passa a GRUPO (05/10/2026)
-- ════════════════════════════════════════════════════════════════════════
-- O dono das apps: "quero que a RCV seja o grupo e que os vinhos que hoje têm
-- a RCV como produtor passem a ter uma das quintas/marcas que compõem a RCV".
-- Corre depois da 43 (casa-mãe). Desfaz, para a RCV, o `db/marcas-do-produtor.sql`
-- da WineCatalog: "Quinta das Carvalhas", "Quinta de Cidrô" e "Quinta dos
-- Aciprestes" deixam de ser grafias da RCV e passam a produtores oficiais
-- com casa-mãe RCV, e o Evel (marca) também.
--
-- Os vinhos mudam de produtor PELO NOME, no catálogo: a ligação
-- (`receber_identidade`) leva o produtor novo às garrafeiras ligadas. O que
-- não está ligado corrige-se aqui à mão, com uma linha no `sync_log`.
-- Os nomes não mudam ("Quinta de Cidrô Arinto" continua), e as quatro ficam
-- na lista do "produtor nunca sai da frente" (`produtores_no_nome`).

DO $$
DECLARE
  v_rcv bigint;
  c record;
  r record;
  v_chave text;
  n int;
BEGIN
  SELECT id INTO v_rcv FROM winecatalog.produtores WHERE nome = 'Real Companhia Velha';
  IF v_rcv IS NULL THEN RAISE EXCEPTION 'Falta a Real Companhia Velha.'; END IF;

  FOR c IN SELECT * FROM (VALUES
      ('Quinta das Carvalhas', '^Quinta das Carvalhas'),
      ('Quinta de Cidrô',      '(Cidrô)'),
      ('Quinta dos Aciprestes','^Quinta dos Aciprestes'),
      ('Evel',                 '^Evel')) t(nome, padrao)
  LOOP
    -- 1. o produtor oficial, da casa-mãe RCV
    INSERT INTO winecatalog.produtores (nome, criado_por, casa_mae_id)
    SELECT c.nome, 'migração 44 (RCV grupo)', v_rcv
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.produtores WHERE lower(nome) = lower(c.nome));
    UPDATE winecatalog.produtores SET casa_mae_id = v_rcv WHERE nome = c.nome;
    -- 2. a grafia passa a ser dele (era da RCV)
    INSERT INTO winecatalog.produtor_variantes (chave, produtor_id, escrito, escritos)
    SELECT winecatalog.chave_produtor(c.nome), p.id, c.nome, ARRAY[c.nome]
      FROM winecatalog.produtores p WHERE p.nome = c.nome
    ON CONFLICT (chave) DO UPDATE SET produtor_id = EXCLUDED.produtor_id;
    -- 3. o produtor fica sempre à frente do nome do vinho
    INSERT INTO winecatalog.produtores_no_nome (chave, produtor, quem)
    SELECT winecatalog.chave_produtor(c.nome), c.nome, 'migração 44 (RCV grupo)'
     WHERE NOT EXISTS (SELECT 1 FROM winecatalog.produtores_no_nome m WHERE m.chave = winecatalog.chave_produtor(c.nome));
    -- 4. os vinhos do catálogo com a RCV e este nome
    PERFORM set_config('winecatalog.quem', 'produtores: RCV grupo', true);
    FOR r IN SELECT v.* FROM winecatalog.vinhos v
              WHERE v.produtor = 'Real Companhia Velha' AND v.nome ~ c.padrao
                AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = v.id)
    LOOP
      v_chave := winecatalog.chave(r.nome, c.nome, r.ano, r.cor);
      IF winecatalog.libertar_chave(v_chave, r.id) THEN
        UPDATE winecatalog.vinhos SET produtor = c.nome WHERE id = r.id;
      ELSE
        RAISE NOTICE 'Catálogo #% (%) ficou: a chave já é de outra linha', r.id, r.nome;
      END IF;
    END LOOP;
    PERFORM set_config('winecatalog.quem', '', true);
    -- 5. as garrafeiras que a ligação não levou
    WITH mudou AS (
      UPDATE garrafeira.vinhos gv SET produtor = c.nome
        FROM (SELECT id, produtor FROM garrafeira.vinhos) antes
       WHERE antes.id = gv.id AND gv.produtor = 'Real Companhia Velha' AND gv.nome ~ c.padrao
      RETURNING gv.id, gv.garrafeira_id
    )
    INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
    SELECT 'winecatalog-batch', 'produtor_oficial', 'ok', 'migração 44 (RCV grupo)',
           jsonb_build_object('vinho_id', id, 'garrafeira_id', garrafeira_id,
                              'antes', 'Real Companhia Velha', 'depois', c.nome)
      FROM mudou;
  END LOOP;
END $$;
