# Guía de estilo DITA del manual de mantenimiento (extracto)

Este extracto de la guía de estilo recoge las convenciones que el equipo de redacción técnica aplica a los temas DITA del manual de mantenimiento del buque. La guía completa tiene once capítulos; aquí solo se incluyen los apartados sobre tareas, advertencias y tablas. Con ella buscamos que todos los redactores escriban de la misma forma y que las revisiones sean más rápidas y menos costosas.

## Tareas

Las tareas describen los procedimientos que el personal de a bordo realiza durante el mantenimiento preventivo y correctivo de los equipos.

Cada paso de una tarea debe contener una sola acción. Si una instrucción necesita dos acciones, se divide en dos elementos <step> consecutivos.

Según la decisión BRDP-D1-00020, el texto del elemento <cmd> se redacta siempre en infinitivo y empieza por el verbo de la acción, por ejemplo «Desmontar la tapa del filtro».

El departamento de ingeniería revisa los procedimientos dos veces al año, normalmente en primavera y en otoño. El equipo de redacción trabaja con un editor XML compartido y publica el manual en HTML5 y en PDF para que pueda consultarse tanto a bordo como en tierra.

## Advertencias y precauciones

Las advertencias de seguridad se marcan siempre con el elemento <hazardstatement> y nunca con <note type="warning">.

Las precauciones que afectan al equipo, y no a las personas, deben ir en un elemento <note type="caution"> colocado antes del paso al que se refieren.

## Tablas

Todas las tablas deben llevar un título en el elemento <title>, aunque la tabla sea pequeña.

## Recordatorio para los redactores

Recuerde que en un mismo <step> no se mezclan dos acciones distintas: cada acción va en su propio paso, aunque sean muy cortas.

Si tiene dudas sobre cualquiera de estas convenciones, consulte al responsable de la documentación del proyecto antes de entregar el tema para revisión. Las propuestas de cambio a la guía se recogen en la reunión mensual del equipo y se incorporan en la siguiente edición.
