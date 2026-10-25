import { crearApp } from "./app.js";

const { app, modelo } = await crearApp();
const puerto = Number(process.env.PORT || 3000);
app.listen(puerto, () => console.log(`${modelo.nombre} escuchando en http://localhost:${puerto}`));
