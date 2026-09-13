# 🪜 Escalera — Cadena de Palabras (Word Chain)

Juego multijugador en tiempo real inspirado en Kahoot, donde cada palabra nueva
debe comenzar con la última letra de la palabra anterior. Ideal para jugar en
salones de clase, practicar vocabulario en inglés o español, y competir en
tiempo real con QR para unirse fácilmente desde el celular.

## ✨ Características

- **🧠 Practicar solo**: modo de entrenamiento individual contra el reloj.
- **⚔️ PvP 1 vs 1**: duelos directos entre dos jugadores.
- **📶 Crear sala**: genera un código y un **QR** para que todos se unan desde
  su celular, como en Kahoot.
- **🔑 Unirse a sala**: ingresa el código generado por el host.
- **👥 Juego por equipos**: crea equipos, cada jugador se une al que quiera,
  el marcador se agrupa por equipo.
- **🎓 Host no juega (por defecto)**: el host solo modera; puede activarse
  "El host también juega" si quiere participar.
- **✅ "Todo vale" con revisión del host**: si se activa, cada palabra pasa
  por aprobación manual del host en vez de validarse contra el diccionario.
- **🚫 No repetir palabras**: opción para no permitir repetir palabras ya
  usadas en la partida/ronda.
- **❌ Descalificación por fallo**: opción para eliminar a un jugador cuando
  falla o se le acaba el tiempo.
- **📚 Diccionarios por categoría** (varias seleccionables a la vez), en
  **inglés y español**: Verbos, Animales, Ciudades, Colores, Comida, Países,
  Deportes, y en inglés además **Verbos en pasado** y **Verbos en
  participio** (para el modo aprendizaje).
- **🧩 Modo asistido**: en vez de escribir, se muestran opciones de palabras
  para elegir con un clic (disponible en práctica, PvP y salas).
- **🎓 Modo aprendizaje** (solo en Practicar solo): si fallas o se acaba el
  tiempo, se muestran pistas de palabras válidas para continuar. Si el
  idioma es inglés, además muestra la forma pasado/participio del verbo
  irregular relacionado con la palabra actual.
- **📖 Visor de diccionario**: explora todas las palabras de una o varias
  categorías, con buscador, tanto desde el menú principal como desde las
  pantallas de configuración.
- **📜 Cadena de palabras expandible**: además de la palabra actual, puedes
  desplegar el historial completo de la partida para ver cómo fue creciendo
  la cadena y quién dijo cada palabra.
- **🌋 Fondo animado** tipo lámpara de lava, con colores que cambian
  suavemente con el tiempo.
- **🎨 Avatares**: cada jugador elige un avatar de una colección variada
  (cortesía de [alohe/avatars](https://github.com/alohe/avatars), servidos vía
  CDN jsDelivr, sin necesidad de alojar imágenes en el proyecto).
- **⏱️ Turnos con tiempo límite**, marcador en vivo y pantalla final con
  ranking (individual o por equipo).
- Sincronización en tiempo real vía **Socket.IO** (WebSockets).

## 🗂️ Estructura del proyecto

```
escalera/
├── server/
│   ├── index.js              # Servidor Express + Socket.IO (toda la lógica en tiempo real)
│   ├── game/
│   │   ├── room.js           # Lógica de una sala (turnos, validación, puntuación)
│   │   ├── roomManager.js    # Registro de salas activas
│   │   ├── dictionaries.js   # Carga y validación de diccionarios/categorías
│   │   └── avatars.js        # Lista de avatares (CDN)
│   └── data/dictionaries/
│       ├── en/ (verbs, animals, cities, colors, food, countries, sports)
│       └── es/ (verbos, animales, ciudades, colores, comida, paises, deportes)
├── public/
│   ├── index.html             # Todas las pantallas (SPA simple)
│   ├── css/style.css          # Estilo tipo Kahoot
│   └── js/app.js              # Lógica de cliente (Socket.IO)
├── package.json
└── README.md
```

## ▶️ Cómo correrlo localmente

Requisitos: Node.js 18+

```bash
npm install
npm start
```

Por defecto corre en `http://localhost:3000` (o el puerto definido en la
variable de entorno `PORT`).

## 🚀 Desplegar en Hostinger

Hostinger permite crear aplicaciones **Node.js** desde el panel (hPanel →
"Sitios web" → "Node.js" o "VPS"). Pasos generales:

### Opción A: Hosting compartido/cloud con soporte Node.js
1. Sube el contenido de esta carpeta al servidor (por Git o el gestor de
   archivos de hPanel).
2. En hPanel, crea una nueva app Node.js y selecciona esta carpeta como raíz.
3. Configura:
   - **Archivo de inicio (startup file):** `server/index.js`
   - **Comando de instalación:** `npm install`
   - **Puerto:** Hostinger asigna automáticamente la variable de entorno
     `PORT`; el servidor ya la respeta (`process.env.PORT`).
4. Inicia/reinicia la aplicación desde el panel.
5. Verifica que el dominio apunte a la app y que **WebSockets** esté
   permitido (necesario para Socket.IO). Si usas un proxy/Nginx delante,
   asegúrate de habilitar `upgrade`/`Connection: Upgrade` para WebSockets.

### Opción B: VPS de Hostinger
1. Instala Node.js 18+ en el VPS.
2. Clona este repositorio.
3. `npm install --production`
4. Usa un gestor de procesos como `pm2` para mantenerlo corriendo:
   ```bash
   npm install -g pm2
   pm2 start server/index.js --name escalera
   pm2 save
   ```
5. Configura Nginx como proxy inverso hacia el puerto de la app, habilitando
   soporte para WebSockets:
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
   }
   ```
6. (Opcional) Activa SSL con Certbot/Let's Encrypt desde hPanel.

> El QR de la sala se genera usando la URL pública del propio servidor
> (`req.protocol` + `req.get('host')`), así que funcionará automáticamente
> con el dominio final configurado en Hostinger — no requiere configuración
> adicional.

## 🎮 Cómo se juega

1. El **host** crea una sala (o duelo PvP), elige idioma, categorías,
   palabra inicial (opcional) y reglas (repetición, descalificación, etc.).
2. Se genera un **código de sala** y un **código QR**. Los jugadores escanean
   el QR o ingresan el código manualmente en "Unirse a sala".
3. Si está activo el modo por equipos, cada jugador elige su equipo desde el
   lobby.
4. El host presiona "Iniciar juego". Se muestra una palabra inicial.
5. En su turno, cada jugador debe escribir una palabra que **empiece con la
   última letra** de la palabra anterior, dentro del tiempo límite.
6. Según las reglas configuradas:
   - Si "todo vale" está activo, el **host revisa manualmente** cada
     respuesta y decide si es válida.
   - Si no, el servidor valida automáticamente contra el diccionario elegido
     y que la palabra no esté repetida.
   - Quien falla o se le acaba el tiempo puede quedar **descalificado**
     (según configuración).
7. El juego termina cuando queda un ganador (PvP) o todos son eliminados
   (party). Se muestra el marcador final individual o por equipos.

## 🧩 Añadir más categorías de palabras

Agrega un archivo `.json` (array de palabras en minúsculas) dentro de
`server/data/dictionaries/en/` o `server/data/dictionaries/es/`. El nombre del
archivo (sin `.json`) se usa como identificador de categoría y aparecerá
automáticamente en el selector del frontend.

## 🖼️ Créditos de avatares

Los avatares provienen del proyecto open-source
[alohe/avatars](https://github.com/alohe/avatars), servidos vía CDN de
jsDelivr.
