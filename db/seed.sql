-- =====================================================================
-- Garrafeira — Arranque (correr DEPOIS de schema/functions/policies)
-- Idempotente: pode ser corrido mais que uma vez.
--
-- Só põe cá dentro o mínimo para a app abrir com alguém lá dentro:
--   · o admin na lista de acesso (senão is_allowed() é true por ser admin,
--     mas ele não aparece na lista de utilizadores e não se pode passar a
--     app a ninguém — definir_admin() exige que o novo dono já lá esteja);
--   · o Barrona, que já tem conta no projeto (vem do Goals) e é para quem
--     esta app vai passar.
--
-- Os VINHOS não vêm por SQL. Vêm pelo botão "Migrar dados iniciais" em
-- Definições, que lê o `dados-iniciais.js` do repo: é lá que 86 garrafas do
-- Excel e do bloco de notas estão já lidas e limpas, e é preciso poder
-- espreitar o que vai entrar ANTES de entrar.
-- =====================================================================

INSERT INTO garrafeira.allowed_users (email, nome, pode_editar)
VALUES ('diogo.andre.f.silva@gmail.com', 'Diogo', true)
ON CONFLICT (email) DO UPDATE SET pode_editar = true;

-- Ajusta o email do Barrona se não for este (é o que ele usa no Goals).
-- Enquanto a conta dele não existir em auth.users isto não faz mal nenhum:
-- a linha fica à espera e o acesso funciona no primeiro login dele.
-- INSERT INTO garrafeira.allowed_users (email, nome, pode_editar)
-- VALUES ('EMAIL-DO-BARRONA@exemplo.com', 'Barrona', true)
-- ON CONFLICT (email) DO UPDATE SET pode_editar = true;
