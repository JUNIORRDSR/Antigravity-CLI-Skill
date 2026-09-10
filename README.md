# Antigravity-CLI-Skill

Plugin para delegar tareas de Claude Code a Antigravity CLI y seguir su ejecución.

## Instalación en Claude Code

### Opción 1: Desde el Marketplace (Recomendado)

Ejecuta estos comandos dentro de la sesión de Claude Code:

```text
/plugin marketplace add JUNIORRDSR/Antigravity-CLI-Skill
/plugin install antigravity@antigravity-cli-skill
```

Para actualizar:

```text
/plugin marketplace update antigravity-cli-skill
```

### Opción 2: Carga directa o desarrollo local

Puedes cargar el repositorio directamente sin marketplace:

```bash
# Apuntando al repositorio local clonado:
claude --plugin-dir .

# O utilizando el paquete .zip generado:
claude --plugin-dir ./dist/antigravity-claude-plugin.zip
```

