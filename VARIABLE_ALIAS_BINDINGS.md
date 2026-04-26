# Scene Variable Alias Bindings (MVP)

This fork supports a compile-time alias syntax that lets scene/entity local variables map to shared global variables.

## Why

GB Studio local event variables (`L0`..`L5`) are convenient for readability, but they still contribute to the same VM variable budget. This feature keeps readable local names while reusing one shared global variable pool intentionally.

## Binding Syntax

Use this exact name pattern on a local variable row:

- `P_<name> => <target>`
- `T_<name> => <target>`
- `T_<name> => <target> !reset` (or `!auto_reset`)

Where `<target>` can be:

- numeric global id (example: `203`)
- global symbol (example: `var_global_tmp`)
- global variable name (example: `Global Tmp`)

## Example

If an actor local variable currently uses `L0`, rename that local variable to:

- `T_enemyIndex => 203`

Then every usage of `L0` in that entity compiles to global variable `203` instead of creating a separate local alias slot.

If the same transient alias target is intentionally shared across multiple scenes, use:

- `T_enemyIndex => 203 !reset`

and explicitly reset that variable in each scene init script.

## Notes

- This is compile-time only; editor UX still shows/edits `L0`..`L5`.
- If a binding target cannot be resolved, compiler falls back to normal local behavior and logs a warning.
- The `P_` / `T_` prefix is required to activate alias parsing.
- The reset marker (`!reset` / `!auto_reset`) is a validation hint; it does not inject reset commands automatically.
- Compiler warns when a `T_` alias target is reused across multiple scenes without reset markers in all scene-init contexts.

