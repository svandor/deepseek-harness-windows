/**
 * Auto route állapotsáv — host-oldali fél.
 *
 * Szándékosan üres: ez tiszta felületi plugin, a böngésző-oldali fél a
 * package.json `exports["./client"]` + `dsh.client` deklaráción keresztül
 * kerül a boot gráfba (ugyanaz a minta, mint a `dsh-client-ui-goal`-nál).
 */
function apply() {}

export { apply };
