// En el inicio: qué productos hay que volver a pedir.
window.appPersonalizada = {
  async inicio(zona, { api, h, numero }) {
    const lista = await api("/por-surtir");
    zona.append(
      h("section", { class: "caja" },
        h("div", { class: "pie-tabla", style: "border-top:0;border-bottom:1px solid var(--linea)" },
          h("strong", { style: "color:var(--tinta)" }, "Por surtir"),
          h("span", {}, lista.length ? `${lista.length} producto(s) en el mínimo o abajo` : "Todo con existencias")),
        lista.length
          ? h("div", { class: "desliza" }, h("table", {},
              h("thead", {}, h("tr", {}, h("th", {}, "Producto"), h("th", { class: "n" }, "Quedan"), h("th", { class: "n" }, "Mínimo"))),
              h("tbody", {}, lista.map((p) => h("tr", { onclick: () => (location.hash = `#/t/productos/${p.id}`) },
                h("td", {}, p.nombre), h("td", { class: "n" }, numero.format(p.existencias ?? 0)), h("td", { class: "n" }, numero.format(p.minimo ?? 0)))))))
          : h("p", { class: "vacio" }, "Ningún producto está por acabarse.")));
  },
};
