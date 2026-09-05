-- =====================================================================
-- Garrafeira — Migração 08: planos de IA por utilizador
--
-- Correr uma vez numa base que já existe, antes de publicar a nova
-- `vinho-info`. No fim, correr também `db/functions.sql`: é lá que fica a
-- função `garrafeira.plano_ia()` usada pela Edge Function.
-- =====================================================================

ALTER TABLE garrafeira.allowed_users
  ADD COLUMN IF NOT EXISTS ia_plano text NOT NULL DEFAULT 'sem_ia';

ALTER TABLE garrafeira.allowed_users
  DROP CONSTRAINT IF EXISTS allowed_users_ia_plano_chk;

ALTER TABLE garrafeira.allowed_users
  ADD CONSTRAINT allowed_users_ia_plano_chk
  CHECK (ia_plano IN ('sem_ia','gratis','premium'));

-- A conta admin é sempre premium pela função SQL; as restantes ficam sem IA
-- até o admin lhes atribuir explicitamente um plano na app.
UPDATE garrafeira.allowed_users
   SET ia_plano = 'sem_ia'
 WHERE ia_plano IS NULL OR ia_plano NOT IN ('sem_ia','gratis','premium');

ALTER TABLE garrafeira.analises
  ADD COLUMN IF NOT EXISTS plano_ia text NOT NULL DEFAULT 'sem_ia';

ALTER TABLE garrafeira.analises
  DROP CONSTRAINT IF EXISTS analises_plano_ia_chk;

ALTER TABLE garrafeira.analises
  ADD CONSTRAINT analises_plano_ia_chk
  CHECK (plano_ia IN ('sem_ia','gratis','premium'));

CREATE INDEX IF NOT EXISTS analises_gratis_quota_idx
  ON garrafeira.analises (quem, criado_em DESC)
  WHERE plano_ia = 'gratis';
