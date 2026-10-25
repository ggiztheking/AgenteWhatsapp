// Las pantallas de la app, armadas a partir del modelo que da el servidor. Sin frameworks: todo con el DOM,
// y los datos siempre como texto (nunca como HTML).
(() => {
  const raiz = document.getElementById("app");
  const ROLES = { lector: "Solo ve", editor: "Ve y edita", admin: "Administrador" };
  const extra = window.appPersonalizada ?? {};
  let est = { usuario: null, modelo: null, pagos: { activo: false, moneda: "MXN" } };

  // --- Utilidades ---
  function h(tag, props = {}, ...hijos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (k === "checked") e.checked = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const x of hijos.flat()) if (x !== null && x !== undefined && x !== false) e.append(x instanceof Node ? x : String(x));
    return e;
  }

  async function api(ruta, { metodo = "GET", datos } = {}) {
    const r = await fetch("/api" + ruta, {
      method: metodo,
      headers: datos ? { "Content-Type": "application/json" } : {},
      body: datos ? JSON.stringify(datos) : undefined,
      credentials: "same-origin",
    });
    let d = null;
    try {
      d = await r.json();
    } catch {}
    if (r.status === 401 && ruta !== "/_entrar") {
      iniciar();
      throw new Error("Tu sesión terminó. Vuelve a entrar.");
    }
    if (!r.ok) throw new Error(d?.error || "Algo falló. Intenta de nuevo.");
    return d;
  }

  let reloj;
  function aviso(texto) {
    const a = document.getElementById("aviso");
    a.textContent = texto;
    a.hidden = false;
    clearTimeout(reloj);
    reloj = setTimeout(() => (a.hidden = true), 3200);
  }

  const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
  const dinero = (n) => new Intl.NumberFormat("es-MX", { style: "currency", currency: est.pagos.moneda || "MXN" }).format(n);
  const fecha = (s) => new Date(s + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
  const fechaHora = (s) => new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });

  function mostrar(c, v, etiquetas) {
    if (v === null || v === undefined || v === "") return "—";
    switch (c.tipo) {
      case "dinero":
        return dinero(v);
      case "numero":
        return numero.format(v);
      case "fecha":
        return fecha(v);
      case "fecha_hora":
        return fechaHora(v);
      case "si_no":
        return v ? "Sí" : "No";
      case "opcion":
        return h("span", { class: "chip" }, v);
      case "relacion":
        return etiquetas?.[c.id]?.[v] ?? `#${v}`;
      default:
        return String(v);
    }
  }

  const ruta = () => {
    const [camino, consulta = ""] = location.hash.replace(/^#/, "").split("?");
    return { partes: camino.split("/").filter(Boolean), consulta: new URLSearchParams(consulta) };
  };
  const ir = (hash) => (location.hash = hash);
  const tabla = (id) => est.modelo.tablas.find((t) => t.id === id);

  // --- Entrar y primera cuenta ---
  function pantallaAcceso(primera, nombreApp) {
    const error = h("p", { class: "error", role: "alert" });
    const campos = primera
      ? [
          h("label", { class: "campo" }, "Tu nombre", h("input", { id: "nombre", name: "nombre", autocomplete: "name", required: true })),
          h("label", { class: "campo" }, "Correo", h("input", { id: "correo", name: "correo", type: "email", autocomplete: "email", required: true })),
          h("label", { class: "campo" }, "Contraseña", h("small", {}, "Al menos 8 caracteres"), h("input", { id: "clave", name: "clave", type: "password", autocomplete: "new-password", minlength: 8, required: true })),
        ]
      : [
          h("label", { class: "campo" }, "Correo", h("input", { id: "correo", name: "correo", type: "email", autocomplete: "email", required: true })),
          h("label", { class: "campo" }, "Contraseña", h("input", { id: "clave", name: "clave", type: "password", autocomplete: "current-password", required: true })),
        ];
    const boton = h("button", { class: "boton principal-b", type: "submit" }, primera ? "Crear mi cuenta" : "Entrar");
    const form = h(
      "form",
      {
        onsubmit: async (ev) => {
          ev.preventDefault();
          error.textContent = "";
          boton.disabled = true;
          const d = Object.fromEntries(new FormData(form));
          try {
            await api(primera ? "/_primer-admin" : "/_entrar", { metodo: "POST", datos: d });
            await iniciar();
          } catch (e) {
            error.textContent = e.message;
            boton.disabled = false;
          }
        },
      },
      h("h1", {}, primera ? `Bienvenido a ${nombreApp}` : nombreApp),
      h("p", {}, primera ? "Crea la cuenta de administrador. Después podrás invitar a tu equipo." : "Entra con tu cuenta."),
      ...campos,
      error,
      boton,
    );
    raiz.replaceChildren(h("main", { class: "entrada" }, form));
    form.querySelector("input").focus();
  }

  // --- Estructura con barra lateral ---
  function marco(actual, ...contenido) {
    const enlace = (hash, texto, clave) => h("a", { href: hash, "aria-current": actual === clave ? "page" : null }, texto);
    const m = est.modelo;
    const lateral = h(
      "nav",
      { class: "lateral", "aria-label": "Secciones" },
      h("div", { class: "marca" }, h("i", { "aria-hidden": "true" }, m.nombre.slice(0, 1).toUpperCase()), m.nombre),
      enlace("#/", "Inicio", "inicio"),
      m.tablas.map((t) => enlace(`#/t/${t.id}`, t.nombre, t.id)),
      est.usuario.rol === "admin" && [h("div", { class: "grupo" }, "Administración"), enlace("#/usuarios", "Usuarios", "usuarios"), enlace("#/historial", "Historial de cambios", "historial")],
      h(
        "div",
        { class: "pie" },
        h("span", {}, est.usuario.nombre, " · ", ROLES[est.usuario.rol]),
        h("a", { href: "#/cuenta" }, "Mi cuenta"),
      ),
    );
    const marcoEl = h("div", { class: "marco" });
    const menu = h("button", { class: "boton menu", type: "button", "aria-label": "Abrir menú", onclick: () => marcoEl.classList.toggle("abierto") }, "☰ Menú");
    lateral.addEventListener("click", (ev) => ev.target.closest("a") && marcoEl.classList.remove("abierto"));
    marcoEl.append(lateral, h("main", { class: "principal" }, menu, ...contenido));
    raiz.replaceChildren(marcoEl);
  }

  const cabeza = (titulo, descripcion, ...acciones) =>
    h("div", { class: "cabeza" }, h("div", {}, h("h1", {}, titulo), descripcion && h("p", {}, descripcion)), h("div", { class: "acciones" }, ...acciones));

  // --- Inicio ---
  async function inicio() {
    const tarjetas = h("div", { class: "resumen" });
    const zonaExtra = h("div", { style: "margin-top:20px; display:grid; gap:16px" });
    marco("inicio", cabeza(est.modelo.nombre, est.modelo.descripcion), tarjetas, zonaExtra);
    const resumen = await api("/_resumen");
    for (const r of resumen) {
      const t = tabla(r.tabla);
      const sumas = t.campos.filter((c) => c.tipo === "dinero" && c.sumar).map((c) => h("span", { class: "extra" }, `${c.nombre}: ${dinero(r.sumas[c.id] ?? 0)}`));
      tarjetas.append(h("a", { class: "tarjeta", href: `#/t/${t.id}` }, h("span", { class: "num" }, numero.format(r.total)), h("span", { class: "eti" }, t.nombre), ...sumas));
    }
    if (extra.inicio) await extra.inicio(zonaExtra, { api, h, dinero, numero, est });
  }

  // --- Lista de una sección ---
  async function lista(t, consulta) {
    const columnas = t.campos.filter((c) => c.en_lista !== false && c.tipo !== "texto_largo").slice(0, 6);
    let orden = "", dir = "", texto = consulta.get("q") ?? "", desde = 0, filas = [], etiquetas = {}, total = 0;
    const buscar = h("input", { class: "buscar", type: "search", placeholder: `Buscar en ${t.nombre.toLowerCase()}`, value: texto, "aria-label": "Buscar" });
    const cuerpo = h("tbody");
    const pie = h("div", { class: "pie-tabla" });
    const encabezado = h(
      "tr",
      {},
      columnas.map((c) =>
        h("th", { class: ["numero", "dinero"].includes(c.tipo) ? "n" : null, scope: "col" },
          h("button", { type: "button", onclick: () => { dir = orden === c.id && dir === "asc" ? "desc" : "asc"; orden = c.id; cargar(true); } }, c.nombre)),
      ),
    );
    const caja = h("div", { class: "caja" }, h("div", { class: "desliza" }, h("table", {}, h("thead", {}, encabezado), cuerpo)), pie);
    marco(
      t.id,
      cabeza(
        t.nombre,
        t.descripcion,
        buscar,
        h("a", { class: "boton", href: `/api/t/${t.id}/csv` }, "Exportar CSV"),
        t.escribir && h("a", { class: "boton principal-b", href: `#/t/${t.id}/nuevo` }, `Agregar ${t.singular.toLowerCase()}`),
      ),
      caja,
    );

    async function cargar(desdeCero) {
      if (desdeCero) { desde = 0; filas = []; }
      const p = new URLSearchParams({ limite: 100, desde });
      if (texto) p.set("q", texto);
      if (orden) { p.set("orden", orden); p.set("dir", dir); }
      const r = await api(`/t/${t.id}?${p}`);
      filas = filas.concat(r.filas);
      total = r.total;
      for (const [k, v] of Object.entries(r.etiquetas)) etiquetas[k] = { ...(etiquetas[k] ?? {}), ...v };
      cuerpo.replaceChildren(
        ...filas.map((f) =>
          h("tr", { tabindex: 0, onclick: () => ir(`#/t/${t.id}/${f.id}`), onkeydown: (ev) => ev.key === "Enter" && ir(`#/t/${t.id}/${f.id}`) },
            columnas.map((c) => h("td", { class: ["numero", "dinero"].includes(c.tipo) ? "n" : null }, mostrar(c, f[c.id], etiquetas)))),
        ),
      );
      if (!filas.length)
        cuerpo.append(h("tr", {}, h("td", { colspan: columnas.length, class: "vacio" }, texto ? "Nada coincide con tu búsqueda." : t.escribir ? `Todavía no hay ${t.nombre.toLowerCase()}. Agrega el primero con el botón de arriba.` : `Todavía no hay ${t.nombre.toLowerCase()}.`)));
      pie.replaceChildren(
        h("span", {}, `${numero.format(filas.length)} de ${numero.format(total)}`),
        h("span", {}, filas.length < total && h("button", { class: "boton chico", type: "button", onclick: () => { desde = filas.length; cargar(false); } }, "Ver más")),
      );
    }
    let pausa;
    buscar.addEventListener("input", () => { clearTimeout(pausa); pausa = setTimeout(() => { texto = buscar.value.trim(); cargar(true); }, 250); });
    await cargar(true);
  }

  // --- Formulario de un registro ---
  const aLocal = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const hoy = () => new Date().toLocaleDateString("en-CA");

  async function control(c, valor, soloVer) {
    const comun = { id: `c-${c.id}`, name: c.id, required: c.requerido || null, disabled: soloVer || null };
    switch (c.tipo) {
      case "texto_largo":
        return h("textarea", { ...comun, value: valor ?? "" });
      case "numero":
        return h("input", { ...comun, type: "number", step: "any", inputmode: "decimal", value: valor ?? "" });
      case "dinero":
        return h("input", { ...comun, type: "number", step: "0.01", min: c.minimo ?? null, inputmode: "decimal", value: valor ?? "" });
      case "fecha":
        return h("input", { ...comun, type: "date", value: valor ?? "" });
      case "fecha_hora":
        return h("input", { ...comun, type: "datetime-local", value: aLocal(valor) });
      case "si_no":
        return h("input", { ...comun, type: "checkbox", checked: !!valor, required: null });
      case "correo":
        return h("input", { ...comun, type: "email", value: valor ?? "" });
      case "telefono":
        return h("input", { ...comun, type: "tel", value: valor ?? "" });
      case "url":
        return h("input", { ...comun, type: "url", value: valor ?? "" });
      case "opcion":
        return h("select", comun, !c.requerido && h("option", { value: "" }, "—"), c.opciones.map((o) => h("option", { value: o, selected: o === valor || null }, o)));
      case "relacion": {
        const otra = tabla(c.tabla);
        const sel = h("select", comun, h("option", { value: "" }, c.requerido ? "Elige…" : "—"));
        if (otra) {
          const r = await api(`/t/${otra.id}?limite=1000&orden=${otra.etiqueta}&dir=asc`);
          for (const f of r.filas) sel.append(h("option", { value: f.id, selected: Number(valor) === f.id || null }, f[otra.etiqueta] ?? `#${f.id}`));
        }
        return sel;
      }
      default:
        return h("input", { ...comun, type: "text", value: valor ?? "" });
    }
  }

  async function formulario(t, id, consulta) {
    const nuevo = id === "nuevo";
    let fila = {};
    if (!nuevo) fila = (await api(`/t/${t.id}/${id}`)).fila;
    else for (const c of t.campos) fila[c.id] = consulta.get(c.id) ?? (c.defecto === "hoy" ? hoy() : c.defecto);
    const soloVer = !t.escribir;
    const error = h("p", { class: "error ancho", role: "alert" });
    const campos = [];
    for (const c of t.campos) {
      const ctl = await control(c, fila[c.id], soloVer);
      campos.push(
        c.tipo === "si_no"
          ? h("label", { class: "casilla" }, ctl, c.nombre)
          : h("label", { class: `campo${c.tipo === "texto_largo" ? " ancho" : ""}` }, c.nombre, c.ayuda && h("small", {}, c.ayuda), ctl),
      );
    }
    const volver = () => ir(`#/t/${t.id}`);
    const guardar = h("button", { class: "boton principal-b", type: "submit" }, nuevo ? `Guardar ${t.singular.toLowerCase()}` : "Guardar cambios");
    const form = h("form", { class: "formulario", novalidate: true }, ...campos, error,
      h("div", { class: "botones" },
        h("div", { class: "acciones" }, !soloVer && guardar, h("button", { class: "boton", type: "button", onclick: volver }, soloVer ? "Volver" : "Cancelar")),
        h("div", { class: "acciones" },
          !nuevo && !soloVer && est.pagos.activo && t.campos.some((c) => c.tipo === "dinero") && h("button", { class: "boton", type: "button", onclick: () => cobrar(t, fila) }, "Link de pago"),
          !nuevo && !soloVer && h("button", { class: "boton peligro", type: "button", onclick: (ev) => borrar(t, fila, ev.currentTarget) }, "Borrar"),
        )));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error.textContent = "";
      const datos = {};
      for (const c of t.campos) {
        const el = form.elements[c.id];
        if (c.tipo === "si_no") datos[c.id] = el.checked;
        else if (c.tipo === "fecha_hora") datos[c.id] = el.value ? new Date(el.value).toISOString() : null;
        else datos[c.id] = el.value;
      }
      guardar.disabled = true;
      try {
        if (nuevo) await api(`/t/${t.id}`, { metodo: "POST", datos });
        else await api(`/t/${t.id}/${id}`, { metodo: "PUT", datos });
        aviso(nuevo ? `${t.singular} agregado` : "Cambios guardados");
        volver();
      } catch (e) {
        error.textContent = e.message;
        guardar.disabled = false;
      }
    });
    const titulo = nuevo ? `Nuevo: ${t.singular.toLowerCase()}` : String(fila[t.etiqueta] ?? `${t.singular} #${id}`);
    const meta = !nuevo && h("p", { class: "meta" }, `Creado ${fechaHora(fila.creado)} · Última modificación ${fechaHora(fila.actualizado)}`);
    marco(t.id, cabeza(titulo, nuevo ? "" : t.nombre), form, meta, !nuevo && await relacionados(t, fila));
    form.querySelector("input:not([type=checkbox]), select, textarea")?.focus();
  }

  /** Registros de otras secciones que apuntan a este (por ejemplo, los movimientos de un producto). */
  async function relacionados(t, fila) {
    const bloques = [];
    for (const otra of est.modelo.tablas)
      for (const c of otra.campos.filter((c) => c.tipo === "relacion" && c.tabla === t.id)) {
        const r = await api(`/t/${otra.id}?${c.id}=${fila.id}&limite=20`);
        const cols = otra.campos.filter((x) => x.id !== c.id && x.en_lista !== false && x.tipo !== "texto_largo").slice(0, 4);
        bloques.push(
          h("section", {},
            h("div", { class: "cabeza" }, h("h2", {}, `${otra.nombre} (${r.total})`),
              otra.escribir && h("a", { class: "boton chico", href: `#/t/${otra.id}/nuevo?${c.id}=${fila.id}` }, `Agregar ${otra.singular.toLowerCase()}`)),
            h("div", { class: "caja" }, h("div", { class: "desliza" }, h("table", {},
              h("thead", {}, h("tr", {}, cols.map((x) => h("th", { class: ["numero", "dinero"].includes(x.tipo) ? "n" : null }, x.nombre)))),
              h("tbody", {}, r.filas.length
                ? r.filas.map((f) => h("tr", { tabindex: 0, onclick: () => ir(`#/t/${otra.id}/${f.id}`) }, cols.map((x) => h("td", { class: ["numero", "dinero"].includes(x.tipo) ? "n" : null }, mostrar(x, f[x.id], r.etiquetas)))))
                : h("tr", {}, h("td", { colspan: cols.length, class: "vacio" }, "Ninguno todavía."))))))),
        );
      }
    return bloques.length ? h("div", { class: "relacionados" }, ...bloques) : null;
  }

  async function borrar(t, fila, boton) {
    if (boton.dataset.confirmar !== "1") {
      boton.dataset.confirmar = "1";
      boton.textContent = "¿Seguro? Toca otra vez para borrar";
      setTimeout(() => { boton.dataset.confirmar = ""; boton.textContent = "Borrar"; }, 4000);
      return;
    }
    try {
      await api(`/t/${t.id}/${fila.id}`, { metodo: "DELETE" });
      aviso(`${t.singular} borrado`);
      ir(`#/t/${t.id}`);
    } catch (e) {
      aviso(e.message);
    }
  }

  async function cobrar(t, fila) {
    const c = t.campos.find((x) => x.tipo === "dinero");
    try {
      const { link } = await api("/_pagos/link", { metodo: "POST", datos: { tabla: t.id, id: fila.id, monto: fila[c.id] } });
      try { await navigator.clipboard.writeText(link); aviso("Link de pago copiado"); } catch { aviso(link); }
    } catch (e) {
      aviso(e.message);
    }
  }

  // --- Usuarios ---
  async function usuarios() {
    const lista = await api("/_usuarios");
    const error = h("p", { class: "error ancho", role: "alert" });
    const form = h("form", { class: "formulario" },
      h("label", { class: "campo" }, "Nombre", h("input", { id: "u-nombre", name: "nombre", required: true })),
      h("label", { class: "campo" }, "Correo", h("input", { id: "u-correo", name: "correo", type: "email", required: true })),
      h("label", { class: "campo" }, "Permiso", h("select", { id: "u-rol", name: "rol" }, Object.entries(ROLES).map(([v, t]) => h("option", { value: v, selected: v === "editor" || null }, t)))),
      h("label", { class: "campo" }, "Contraseña inicial", h("small", {}, "Compártela con la persona; puede cambiarla en Mi cuenta"), h("input", { id: "u-clave", name: "clave", type: "text", minlength: 8, required: true, autocomplete: "off" })),
      error,
      h("div", { class: "botones" }, h("button", { class: "boton principal-b", type: "submit" }, "Agregar persona")));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error.textContent = "";
      try {
        await api("/_usuarios", { metodo: "POST", datos: Object.fromEntries(new FormData(form)) });
        aviso("Persona agregada");
        usuarios();
      } catch (e) { error.textContent = e.message; }
    });
    const cambiar = async (u, datos) => {
      try { await api(`/_usuarios/${u.id}`, { metodo: "PUT", datos }); aviso("Guardado"); } catch (e) { aviso(e.message); usuarios(); }
    };
    marco("usuarios",
      cabeza("Usuarios", "Quién puede entrar y qué puede hacer."),
      h("div", { class: "caja", style: "margin-bottom:24px" }, h("div", { class: "desliza" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Nombre"), h("th", {}, "Correo"), h("th", {}, "Permiso"), h("th", {}, "Activo"))),
        h("tbody", {}, lista.map((u) => h("tr", { style: "cursor:default" },
          h("td", {}, u.nombre), h("td", {}, u.correo),
          h("td", {}, h("select", { "aria-label": `Permiso de ${u.nombre}`, onchange: (ev) => cambiar(u, { rol: ev.target.value }) }, Object.entries(ROLES).map(([v, t]) => h("option", { value: v, selected: v === u.rol || null }, t)))),
          h("td", {}, h("input", { type: "checkbox", checked: u.activo, "aria-label": `${u.nombre} activo`, onchange: (ev) => cambiar(u, { activo: ev.target.checked }) })))))))),
      h("h2", { style: "font-size:17px" }, "Agregar a alguien"),
      form);
  }

  // --- Historial ---
  async function historial() {
    const lista = await api("/_historial");
    const ACC = { crear: "Agregó", editar: "Editó", borrar: "Borró", pago: "Pago recibido" };
    const nombreTabla = (id) => (id === "_usuarios" ? "Usuarios" : tabla(id)?.nombre ?? id);
    marco("historial",
      cabeza("Historial de cambios", "Los últimos 300 cambios: quién, qué y cuándo."),
      h("div", { class: "caja" }, h("div", { class: "desliza" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Cuándo"), h("th", {}, "Quién"), h("th", {}, "Qué"), h("th", {}, "Detalle"))),
        h("tbody", {}, lista.length ? lista.map((x) => h("tr", { style: "cursor:default", onclick: () => x.tabla !== "_usuarios" && x.accion !== "borrar" && tabla(x.tabla) && ir(`#/t/${x.tabla}/${x.registro}`) },
          h("td", {}, fechaHora(x.fecha)), h("td", {}, x.usuario ?? "Sistema"),
          h("td", {}, `${ACC[x.accion] ?? x.accion} · ${nombreTabla(x.tabla)} #${x.registro ?? ""}`),
          h("td", { class: "mono", title: JSON.stringify(x.cambios) }, JSON.stringify(x.cambios ?? {}).slice(0, 120))))
          : h("tr", {}, h("td", { colspan: 4, class: "vacio" }, "Todavía no hay cambios."))))))
    );
  }

  // --- Mi cuenta ---
  function cuenta() {
    const error = h("p", { class: "error ancho", role: "alert" });
    const form = h("form", { class: "formulario" },
      h("label", { class: "campo" }, "Contraseña actual", h("input", { id: "actual", name: "actual", type: "password", autocomplete: "current-password", required: true })),
      h("label", { class: "campo" }, "Nueva contraseña", h("input", { id: "nueva", name: "nueva", type: "password", autocomplete: "new-password", minlength: 8, required: true })),
      error,
      h("div", { class: "botones" }, h("button", { class: "boton principal-b", type: "submit" }, "Cambiar contraseña"),
        h("button", { class: "boton", type: "button", onclick: async () => { await api("/_salir", { metodo: "POST" }); location.hash = ""; iniciar(); } }, "Salir")));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      error.textContent = "";
      try { await api("/_mi-clave", { metodo: "POST", datos: Object.fromEntries(new FormData(form)) }); form.reset(); aviso("Contraseña cambiada"); }
      catch (e) { error.textContent = e.message; }
    });
    marco("cuenta", cabeza("Mi cuenta", `${est.usuario.nombre} · ${est.usuario.correo} · ${ROLES[est.usuario.rol]}`), form);
  }

  // --- Navegación ---
  async function mostrarRuta() {
    if (!est.usuario) return;
    const { partes, consulta } = ruta();
    try {
      if (partes[0] === "t" && tabla(partes[1])) {
        const t = tabla(partes[1]);
        if (partes[2]) await formulario(t, partes[2], consulta);
        else await lista(t, consulta);
      } else if (partes[0] === "usuarios" && est.usuario.rol === "admin") await usuarios();
      else if (partes[0] === "historial" && est.usuario.rol === "admin") await historial();
      else if (partes[0] === "cuenta") cuenta();
      else await inicio();
      window.scrollTo(0, 0);
    } catch (e) {
      marco("", cabeza("No se pudo abrir"), h("p", { class: "error" }, e.message), h("a", { class: "boton", href: "#/" }, "Ir al inicio"));
    }
  }

  async function iniciar() {
    raiz.classList.remove("cargando");
    raiz.removeAttribute("aria-busy");
    const e = await api("/_estado");
    document.title = e.app;
    if (e.color) document.documentElement.style.setProperty("--acento", e.color);
    if (!e.configurada) return pantallaAcceso(true, e.app);
    if (!e.usuario) return pantallaAcceso(false, e.app);
    est.usuario = e.usuario;
    [est.modelo, est.pagos] = await Promise.all([api("/_modelo"), api("/_pagos/estado")]);
    await mostrarRuta();
  }

  window.addEventListener("hashchange", mostrarRuta);
  iniciar().catch((e) => { raiz.textContent = e.message; });
})();
