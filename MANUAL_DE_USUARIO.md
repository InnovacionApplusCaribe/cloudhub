# Manual de Usuario - Plataforma de Visualización de Nubes de Puntos (Potree)

## 1. Introducción
Este documento proporciona una guía detallada sobre cómo utilizar la plataforma de visualización 3D basada en Potree. La plataforma permite explorar nubes de puntos de alta densidad, interactuar con capas vectoriales (GIS) y realizar mediciones precisas en el entorno tridimensional.

## 2. Navegación Básica en el Visor 3D
La interacción principal con la nube de puntos se realiza mediante el ratón y los controles de cámara:
*   **Rotar / Orbitar**: Mantenga presionado el botón izquierdo del ratón y arrastre para girar la cámara alrededor del modelo.
*   **Desplazar (Panorámica)**: Mantenga presionado el botón derecho del ratón (o la rueda del ratón) y arrastre para mover la vista lateralmente o hacia arriba/abajo.
*   **Acercar / Alejar (Zoom)**: Utilice la rueda de desplazamiento del ratón para hacer zoom hacia adelante o hacia atrás. Alternativamente, hacer doble clic en un punto centra y acerca la vista a esa ubicación específica.

## 3. Panel Lateral (Menú Principal)
En la parte izquierda de la pantalla se encuentra el panel de control lateral, que se divide en varias secciones funcionales:

### 3.1. Herramientas de Medición y Dibujo (Tools)
Esta barra de herramientas contiene iconos para realizar diversas mediciones sobre la nube de puntos. Para usar una herramienta, haga clic en su icono y luego haga clic en la nube de puntos para definir los vértices de la medición:
*   **Ángulo (Angle)**: Mide el ángulo interno formado por tres puntos seleccionados.
*   **Punto (Point)**: Muestra las coordenadas espaciales exactas (X, Y, Z) de un punto específico al hacer clic.
*   **Distancia (Distance)**: Mide la longitud lineal entre múltiples puntos (creando segmentos de línea).
*   **Altura (Height)**: Mide la diferencia de elevación (distancia vertical) entre dos puntos.
*   **Círculo (Circle)**: Dibuja un círculo definido por tres puntos sobre la superficie, calculando su radio y área.
*   **Azimut (Azimuth)**: Mide la orientación o ángulo horizontal respecto al norte entre dos puntos.
*   **Área (Area)**: Calcula la superficie de un polígono cerrado dibujado sobre la nube de puntos.
*   **Volumen (Volume)**: Calcula el volumen (corte/relleno) dentro de un cubo o esfera delimitadora definida por el usuario.
*   **Perfil (Profile)**: Genera un perfil de elevación transversal en 2D a lo largo de una línea trazada en el mapa.
*   **Anotación (Annotation)**: Permite agregar etiquetas de texto personalizadas en puntos específicos de la escena 3D.
*   **Eliminar todo (Remove All)**: Borra permanentemente todas las mediciones y anotaciones actuales de la vista.

### 3.2. Escena (Scene)
Esta sección administra y organiza todos los elementos cargados en el visor 3D mediante un árbol de capas interactivo:
*   **Point Clouds (Nubes de Puntos)**: Permite activar o desactivar la visualización de los modelos 3D principales.
*   **Measurements (Mediciones)**: Lista todas las mediciones y perfiles creados. Al seleccionar una medición en la lista, la cámara se enfoca en ella y se muestran sus propiedades.
*   **Vectors / GIS Layers (Vectores)**: Contiene los elementos geométricos (polígonos, líneas, puntos) provenientes de archivos cartográficos.
*   **Exportación**: Permite guardar las mediciones y anotaciones realizadas en formatos compatibles con otros sistemas. Soporta exportación en **GeoJSON**, **DXF** y **Potree (JSON5)**.

### 3.3. Exploración de Capas GIS y Atributos
La plataforma cuenta con soporte optimizado para capas vectoriales y visualización de metadatos:
*   **Navegación Vectorial**: En el árbol de la Escena (sección Vectors), puede expandir las capas GIS para ver los elementos individuales (ej. lotes, edificaciones, zonas).
*   **Inspección Rápida**: Al hacer doble clic en un elemento vectorial en el árbol de capas, la cámara realizará un zoom automático para enmarcar la geometría de dicho elemento.
*   **Panel de Propiedades (Properties Panel)**: Al seleccionar un elemento vectorial o una anotación en la lista, el sistema desplegará en la parte inferior un panel de propiedades. Aquí podrá inspeccionar atributos específicos provenientes del archivo Shapefile o base de datos original (como el ID del objeto, tipo de riesgo, descripción, etc.).

### 3.4. Apariencia y Rendimiento (Appearance)
Permite ajustar visualmente la nube de puntos para mejorar la apreciación o el rendimiento:
*   **Point Budget (Límite de Puntos)**: Controla la cantidad máxima de puntos que se renderizan simultáneamente. Un valor mayor mejora el detalle visual pero exige más a la tarjeta gráfica.
*   **Tamaño de Punto (Point Size)**: Ajusta el grosor de los puntos.
*   **Material**: Permite colorear la nube de puntos según distintos criterios disponibles, como el Color Real (RGB), Elevación (para mapas de calor topográficos), Intensidad de retorno, o Clasificación.

## 4. Recomendaciones Finales
*   **Rendimiento con Capas Grandes**: Al cargar archivos vectoriales masivos, el sistema procesa los elementos en segundo plano (bloques asincrónicos). Es posible que los nodos en el árbol de vectores tarden unos segundos en aparecer completamente, permitiendo que la interfaz siga respondiendo sin congelarse.
*   **Exactitud de las Mediciones**: Asegúrese de hacer un nivel de zoom adecuado y de interactuar sobre zonas con suficiente densidad de puntos para que los vértices de medición se apoyen correctamente en la superficie real y no en espacios vacíos.
