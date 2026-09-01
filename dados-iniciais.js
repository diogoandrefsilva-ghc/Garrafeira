/* dados-iniciais.js — o que já existia, antes de haver app.
 *
 * GERADO a partir das duas fontes que existiam à mão:
 *   · Garrafeira_Sala_Barrona.xlsx  (Nº · Vinho · Região · Estágio · Castas)
 *   · o bloco de notas dos "Níveis"  (Nível 1..14 + Móvel, numerados 1..62)
 *
 * Não é usado no arranque da app: só o botão "Migrar dados iniciais"
 * (Definições › Dados) lhe toca, e mesmo esse mostra tudo antes de gravar.
 * Depois da migração feita, isto fica aqui só como registo do ponto de
 * partida — apagar não muda nada na app.
 *
 * O QUE FOI LIMPO ao ler as fontes (e porquê fica escrito):
 *   · o ANO vinha colado ao nome ("… Douro2021", "2023l") — foi separado
 *     para a coluna própria, que é o que deixa filtrar por ano;
 *   · a REGIÃO vinha no meio do nome no bloco de notas — passou a campo;
 *   · "Alicante Bousquet" e "Alicante Bouschet" são a mesma casta escrita
 *     de duas maneiras: ficaram uma só, senão a procura por casta perdia
 *     metade dos vinhos;
 *   · os NÚMEROS sem vinho à frente (12-, 33-, 37-, 41-, 43-, 52-, 61-…)
 *     são lugares vazios, não vinhos — foram deitados fora;
 *   · o Quinta do Vallado 2021 estava nos lugares 54 E 55: é UM vinho com
 *     DUAS garrafas, e é assim que entra (o mesmo para o que se repetir);
 *   · dois vinhos ficaram SEM região (o nome não a trazia) — entram com o
 *     campo vazio, à espera do botão de procurar da IA.
 *
 * As castas do bloco de notas não existem (a fonte não as tinha): 54 dos
 * 85 vinhos entram sem castas nenhumas. É de propósito — inventá-las
 * aqui era pôr na base de dados coisas que ninguém verificou. Quem as vai
 * buscar é o botão de procura da IA, vinho a vinho, com confirmação.
 */
const DADOS_INICIAIS = {
  locais: [{"nome":"Garrafeira Principal","descricao":"Níveis 1 a 14 e o móvel","cor":"#7b1f3d","ordem":1},{"nome":"Garrafeira da Sala","descricao":"Aparador da sala de estar","cor":"#2d6a4f","ordem":2}],
  // 85 vinhos, 86 garrafas
  vinhos: [
    {"nome":"Herdade do Mouchão","ano":2016,"regiao":"Alentejo","tipo":"Tinto","castas":["Alicante Bouschet","Trincadeira"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"1"}],"mencao":""},
    {"nome":"Herdade dos Grous Reserva","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":["Aragonez","Alicante Bouschet","Syrah","Touriga Nacional"],"estagioMeses":16,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"2"}],"mencao":"Reserva"},
    {"nome":"Quinta do Carmo Reserva","ano":2016,"regiao":"Alentejo","tipo":"Tinto","castas":["Aragonez","Alicante Bouschet","Syrah","Cabernet Sauvignon"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"3"}],"mencao":"Reserva"},
    {"nome":"Herdade da Malhadinha Nova Malhadinha","ano":2022,"regiao":"Alentejo","tipo":"Tinto","castas":["Alicante Bouschet","Aragonez","Tinta Miúda","Touriga Nacional"],"estagioMeses":16,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"4"}],"mencao":""},
    {"nome":"Esporão Touriga Nacional","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":["Touriga Nacional"],"estagioMeses":12,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"5"}],"mencao":""},
    {"nome":"Herdade Papa Leite Pacto do Diabo","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":["Cabernet Sauvignon","Alicante Bouschet","Merlot"],"estagioMeses":20,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"6"}],"mencao":""},
    {"nome":"Vinha das Virtudes Humanitas Reserva","ano":2020,"regiao":"Alentejo","tipo":"Tinto","castas":["Syrah"],"estagioMeses":15,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"7"}],"mencao":"Reserva"},
    {"nome":"Herdade da Maroteira Cem Reis","ano":2023,"regiao":"Alentejo","tipo":"Tinto","castas":["Syrah"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"8"}],"mencao":""},
    {"nome":"Herdade da Cartuxa Reserva","ano":2017,"regiao":"Alentejo","tipo":"Tinto","castas":["Alicante Bouschet","Aragonez","Trincadeira"],"estagioMeses":15,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"9"}],"mencao":"Reserva"},
    {"nome":"Carmim Reguengos Garrafeira dos Sócios","ano":2019,"regiao":"Alentejo","tipo":"Tinto","castas":["Aragonez","Alicante Bouschet","Cabernet Sauvignon"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"10"}],"mencao":"Garrafeira"},
    {"nome":"Palácio da Bacalhoa","ano":2016,"regiao":"Setúbal","tipo":"Tinto","castas":["Cabernet Sauvignon","Merlot","Petit Verdot"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"12"}],"mencao":""},
    {"nome":"Quinta do Piloto Colecção da Família","ano":2020,"regiao":"Setúbal","tipo":"Tinto","castas":["Castelão"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"13"}],"mencao":""},
    {"nome":"Ermelinda de Freitas Garrafeira","ano":2017,"regiao":"Setúbal","tipo":"Tinto","castas":["Alicante Bouschet","Castelão","Pinot Noir","Trincadeira"],"estagioMeses":12,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"15"}],"mencao":"Garrafeira"},
    {"nome":"Sivipa Palmela Grande Reserva","ano":2020,"regiao":"Setúbal","tipo":"Tinto","castas":["Castelão","Touriga Nacional","Cabernet Sauvignon"],"estagioMeses":16,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"16"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta da Alorna Marquesa da Alorna","ano":2019,"regiao":"Tejo","tipo":"Tinto","castas":["Touriga Nacional","Touriga Franca","Castelão","Syrah"],"estagioMeses":14,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"17"}],"mencao":""},
    {"nome":"Casa Cadaval Marquesa de Cadaval","ano":2015,"regiao":"Tejo","tipo":"Tinto","castas":["Touriga Nacional","Trincadeira","Alicante Bouschet"],"estagioMeses":16,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"18"}],"mencao":""},
    {"nome":"Caves Primavera Garrafeira","ano":2015,"regiao":"Bairrada","tipo":"Tinto","castas":["Baga","Touriga Nacional"],"estagioMeses":12,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"19"}],"mencao":"Garrafeira"},
    {"nome":"Casa de Saima Garrafeira","ano":2015,"regiao":"Bairrada","tipo":"Tinto","castas":["Baga"],"estagioMeses":12,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"20"}],"mencao":"Garrafeira"},
    {"nome":"Quinta das Bágeiras Garrafeira","ano":2020,"regiao":"Bairrada","tipo":"Tinto","castas":["Baga"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"21"}],"mencao":"Garrafeira"},
    {"nome":"Messias Garrafeira","ano":2018,"regiao":"Bairrada","tipo":"Tinto","castas":["Baga"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"22"}],"mencao":"Garrafeira"},
    {"nome":"Casa do Canto Grande Reserva","ano":2018,"regiao":"Bairrada","tipo":"Tinto","castas":["Baga","Touriga Nacional"],"estagioMeses":12,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"23"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta da Curia Clefs D'or","ano":2014,"regiao":"Bairrada","tipo":"Tinto","castas":["Merlot","Touriga Nacional","Cabernet Sauvignon"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"24"}],"mencao":""},
    {"nome":"Caves Primavera Clássico 80 anos","ano":2019,"regiao":"Bairrada","tipo":"Tinto","castas":["Baga"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"25"}],"mencao":""},
    {"nome":"Lavradores de Feitoria Três Bagos Grande Escolha","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":["Field Blend"],"estagioMeses":14,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"26"}],"mencao":"Grande Escolha"},
    {"nome":"Ramos Pinto Duas Quintas Reserva","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":["Touriga Nacional","Touriga Franca","Tinta Roriz","Sousão","Tinto Cão","Tinta Amarela"],"estagioMeses":16,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"27"}],"mencao":"Reserva"},
    {"nome":"Quinta dos Aciprestes Grande Reserva","ano":2017,"regiao":"Douro","tipo":"Tinto","castas":["Touriga Nacional","Touriga Franca"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"28"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta da Vacaria Reserva","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":["Tinta Roriz","Touriga Franca","Touriga Nacional"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"29"}],"mencao":"Reserva"},
    {"nome":"Casa Ferreirinha Quinta da Leda","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":["Touriga Franca","Touriga Nacional","Tinto Cão","Tinta Roriz"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"30"}],"mencao":""},
    {"nome":"Quinta das Carvalhas Vinhas Velhas","ano":2020,"regiao":"Douro","tipo":"Tinto","castas":["Field Blend"],"estagioMeses":18,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"31"}],"mencao":"Vinhas Velhas"},
    {"nome":"Casa Ferreirinha Antónia Adelaide Ferreira Tinto","ano":2020,"regiao":"Douro","tipo":"Tinto","castas":["Touriga Nacional","Touriga Franca","Field Blend","Sousão"],"estagioMeses":24,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"32"}],"mencao":""},
    {"nome":"Quinta da Gaivosa","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":["Touriga Franca","Touriga Nacional","Tinto Cão"],"estagioMeses":20,"garrafas":[{"local":"Garrafeira da Sala","prateleira":"","lugar":"34"}],"mencao":""},
    {"nome":"Casa Santos Lima Completo Grande Reserva","ano":2020,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 1","lugar":"1"}],"mencao":"Grande Reserva"},
    {"nome":"Mamoré de Borba Passos dos Terceiros Garrafeira Syrah","ano":2016,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 1","lugar":"2"}],"mencao":"Garrafeira"},
    {"nome":"Herdade dos Grous Moon Harvest","ano":2023,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 1","lugar":"3"}],"mencao":""},
    {"nome":"Morais Rocha Reserva","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 1","lugar":"4"}],"mencao":"Reserva"},
    {"nome":"Rosa Santos Explicit Reserva","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 2","lugar":"5"}],"mencao":"Reserva"},
    {"nome":"Senhor Doutor Reserva Touriga Nacional","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 2","lugar":"6"}],"mencao":"Reserva"},
    {"nome":"Comenda Grande Reserva","ano":2019,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 2","lugar":"7"}],"mencao":"Grande Reserva"},
    {"nome":"Ravasqueira Reserva da Família","ano":2022,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 3","lugar":"8"}],"mencao":"Reserva"},
    {"nome":"Ravasqueira Vinha das Romãs","ano":2020,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 3","lugar":"9"}],"mencao":""},
    {"nome":"Aldeias de Juromenha Syrah Reserva","ano":2023,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 3","lugar":"10"}],"mencao":"Reserva"},
    {"nome":"Herdade dos Grous 23 Barricas","ano":2022,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 3","lugar":"11"}],"mencao":""},
    {"nome":"Mal Acompanhado JCA","ano":2021,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 4","lugar":"13"}],"mencao":""},
    {"nome":"Caves Velhas Romeira Merlot Reserva","ano":2023,"regiao":"","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 4","lugar":"14"}],"mencao":"Reserva"},
    {"nome":"Ermelinda Freitas Grande Reserva","ano":2021,"regiao":"Setúbal","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 5","lugar":"15"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta do Boição Vinhas Velhas Grande Reserva","ano":2018,"regiao":"Lisboa","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 5","lugar":"16"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta de São João Batista Grande Reserva","ano":2019,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 5","lugar":"17"}],"mencao":"Grande Reserva"},
    {"nome":"Cabeça de Toiro Reserva Privada Alicante Bouschet","ano":2018,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 5","lugar":"18"}],"mencao":"Reserva"},
    {"nome":"Colheita dos Amigos Reserva","ano":2013,"regiao":"Setúbal","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 6","lugar":"19"}],"mencao":"Reserva"},
    {"nome":"Casa Cadaval Cabernet Sauvignon","ano":2022,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 6","lugar":"20"}],"mencao":""},
    {"nome":"Casa Cadaval Reserva","ano":2021,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 6","lugar":"21"}],"mencao":"Reserva"},
    {"nome":"Casa Cadaval Trincadeira Preta Vinhas Velhas","ano":2022,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 7","lugar":"22"}],"mencao":"Vinhas Velhas"},
    {"nome":"Reserva das Pedras Alicante Bouschet","ano":2021,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 7","lugar":"23"}],"mencao":"Reserva"},
    {"nome":"Quinta da Bacalhoa Cabernet Sauvignon","ano":2017,"regiao":"Setúbal","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 7","lugar":"24"}],"mencao":""},
    {"nome":"Terras de Burel Grande Reserva","ano":2016,"regiao":"Beira Interior","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 7","lugar":"25"}],"mencao":"Grande Reserva"},
    {"nome":"Marquês de Marialva Grande Reserva","ano":2017,"regiao":"Bairrada","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 8","lugar":"26"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta dos Termos Reserva do Patrão Syrah","ano":2021,"regiao":"Beira Interior","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 8","lugar":"27"}],"mencao":"Reserva"},
    {"nome":"Taboadella Jaen Reserva","ano":2021,"regiao":"Dão","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 8","lugar":"28"}],"mencao":"Reserva"},
    {"nome":"Grande Piano Grande Reserva","ano":2017,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 9","lugar":"29"}],"mencao":"Grande Reserva"},
    {"nome":"Bafarela Grande Reserva","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 9","lugar":"30"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta da Romaneira Dona Clara","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 9","lugar":"31"}],"mencao":""},
    {"nome":"Quinta da Romaneira Petit Verdot","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 9","lugar":"32"}],"mencao":""},
    {"nome":"Quinta do Crasto Superior","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 10","lugar":"32"}],"mencao":"Superior"},
    {"nome":"Terra a Terra Reserva","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 10","lugar":"33"}],"mencao":"Reserva"},
    {"nome":"Bacalhoa Quinta dos Quatro Ventos Reserva","ano":2020,"regiao":"","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 11","lugar":"35"}],"mencao":"Reserva"},
    {"nome":"Beyra Grande Reserva","ano":2021,"regiao":"Beiras","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 11","lugar":"36"}],"mencao":"Grande Reserva"},
    {"nome":"Dourum Field Blend Reserva","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 12","lugar":"38"}],"mencao":"Reserva"},
    {"nome":"Carm Grande Reserva","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 12","lugar":"40"}],"mencao":"Grande Reserva"},
    {"nome":"Quinta do Cidrô Cabernet Sauvignon Touriga Nacional","ano":2016,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 13","lugar":"42"}],"mencao":""},
    {"nome":"Quinta do Cidrô Touriga Nacional","ano":2020,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 13","lugar":"44"}],"mencao":""},
    {"nome":"Quinta Nova Touriga Nacional Reserva","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 14","lugar":"45"}],"mencao":"Reserva"},
    {"nome":"Santos e Seixo Santos da Casa Grande Reserva","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Nível 14","lugar":"46"}],"mencao":"Grande Reserva"},
    {"nome":"Casa Ferreirinha Vinha Grande","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"47"}],"mencao":""},
    {"nome":"Casa Ferreirinha Callabriga","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"48"}],"mencao":""},
    {"nome":"Casa Ferreirinha Castas Escondidas","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"49"}],"mencao":""},
    {"nome":"Quinta do Cume Reserva","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"50"}],"mencao":"Reserva"},
    {"nome":"100 Hectares Vinhas Velhas","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"51"}],"mencao":"Vinhas Velhas"},
    {"nome":"Montes Ermos Garrafeira dos Sócios","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"53"}],"mencao":"Garrafeira"},
    {"nome":"Quinta do Vallado Touriga Nacional","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"54"},{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"55"}],"mencao":""},
    {"nome":"Symington Pombal do Vesúvio","ano":2022,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"56"}],"mencao":""},
    {"nome":"Carlos Alonso Piano 17","ano":2019,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"57"}],"mencao":""},
    {"nome":"Post Scriptum de Chrysea","ano":2021,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"58"}],"mencao":""},
    {"nome":"Carm Touriga Nacional","ano":2020,"regiao":"Douro","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"59"}],"mencao":""},
    {"nome":"Bridão Private Collection","ano":2019,"regiao":"Tejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"60"}],"mencao":""},
    {"nome":"Esporão Alicante Bouschet","ano":2015,"regiao":"Alentejo","tipo":"Tinto","castas":[],"estagioMeses":null,"garrafas":[{"local":"Garrafeira Principal","prateleira":"Móvel","lugar":"62"}],"mencao":""},
  ]
};
