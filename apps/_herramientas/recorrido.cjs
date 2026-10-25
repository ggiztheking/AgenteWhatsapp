// Recorrido de humo en un navegador real: crea la cuenta de administrador, abre cada sección, agrega un
// registro en la primera y guarda capturas (compu y celular). Falla si la página tira errores.
// Uso: node recorrido.cjs <url-de-la-app> <carpeta-de-capturas>
const { chromium } = require("playwright");

const [base, salida] = process.argv.slice(2);

async function llenar(page) {
  const form = page.locator("form.formulario");
  for (const el of await form.locator("input, select, textarea").all()) {
    if (!(await el.isEditable())) continue;
    const tipo = (await el.getAttribute("type")) ?? (await el.evaluate((e) => e.tagName.toLowerCase()));
    const requerido = (await el.getAttribute("required")) !== null;
    const valor = await el.inputValue().catch(() => "");
    if (valor && tipo !== "select") continue;
    if (tipo === "select") {
      const opciones = await el.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
      if (opciones.length && (requerido || !valor)) await el.selectOption(opciones[0]);
    } else if (tipo === "checkbox") {
      await el.check();
    } else if (tipo === "number") await el.fill("10");
    else if (tipo === "date") await el.fill("2026-11-02");
    else if (tipo === "datetime-local") await el.fill("2026-11-02T15:30");
    else if (tipo === "email") await el.fill("recorrido@ejemplo.com");
    else if (tipo === "url") await el.fill("https://ejemplo.com");
    else if (tipo === "tel") await el.fill("9991234567");
    else await el.fill("Registro de prueba");
  }
}

(async () => {
  const navegador = await chromium.launch();
  const errores = [];
  const page = await navegador.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => errores.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.text()) && errores.push(m.text()));

  await page.goto(base);
  await page.getByRole("button", { name: "Crear mi cuenta" }).waitFor();
  await page.screenshot({ path: `${salida}/1-primera-cuenta.png` });
  await page.fill("#nombre", "Prueba Recorrido");
  await page.fill("#correo", "dueno@ejemplo.com");
  await page.fill("#clave", "clave-recorrido-1");
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await page.locator("nav.lateral").waitFor();
  await page.locator(".tarjeta").first().waitFor();
  await page.screenshot({ path: `${salida}/2-inicio.png` });

  const secciones = await page.locator("nav.lateral a[href^='#/t/']").all();
  if (!secciones.length) throw new Error("No aparece ninguna sección en el menú");
  for (const s of secciones) {
    await s.click();
    await page.locator("table").first().waitFor();
  }

  // Agregar un registro en la primera sección.
  await secciones[0].click();
  await page.locator("table").first().waitFor();
  await page.screenshot({ path: `${salida}/3-lista-vacia.png` });
  await page.locator(".cabeza a.principal-b").click();
  await page.locator("form.formulario").waitFor();
  await page.waitForTimeout(300);
  await llenar(page);
  await page.screenshot({ path: `${salida}/4-formulario.png` });
  await page.locator("form.formulario button[type=submit]").click();
  const error = page.locator("form.formulario .error");
  await Promise.race([
    page.locator("tbody tr[tabindex]").first().waitFor(),
    error.filter({ hasText: /./ }).waitFor().then(async () => { throw new Error("No se pudo guardar: " + (await error.textContent())); }),
  ]);
  await page.screenshot({ path: `${salida}/5-lista-con-registro.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/#/");
  await page.locator(".tarjeta").first().waitFor();
  await page.screenshot({ path: `${salida}/6-celular.png` });
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
  if (ancho > 392) errores.push(`En celular la página es más ancha que la pantalla (${ancho}px)`);

  await navegador.close();
  if (errores.length) throw new Error("Errores en la página:\n" + errores.join("\n"));
  console.log("  recorrido completo: cuenta creada, secciones abiertas, registro agregado");
})().catch((e) => {
  console.error("✗ Recorrido:", e.message);
  process.exit(1);
});
