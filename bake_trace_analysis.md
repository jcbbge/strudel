# How Strudel Executes a Bake

## Overview
Strudel's bake execution is handled by the `oven.ts` module, which processes recipes (defined in `recipe.ts`) and executes them step by step.

## Key Components

### 1. Recipe Structure (from recipe.ts)
A recipe consists of:
- `name`: Recipe identifier
- `version`: Optional version number
- `description`: What the recipe does
- `when_to_use`: Usage guidance
- `params`: Array of parameter names
- `layers`: Array of execution steps

Each layer has:
- `step`: Sequential number (1-indexed)
- `ingredient`: Tool name to execute
- `inputs`: Parameters for the tool, may contain `{param}` tokens

### 2. Bake Execution (from oven.ts)

#### Main Functions:

**`bake(recipe: Recipe): Promise<BakeResult>`** - Core execution function:
1. Sorts layers by step number
2. For each layer:
   - Loads the tool using `loadTool()`
   - Resolves `$N.field` bindings via `resolveBindings()`
   - Expands tildes in paths
   - Executes the tool
   - Captures output, duration, and errors
3. Persists workspace state
4. Returns `BakeResult` with all step details

**`loadTool(name: string): Promise<Function>`**:
1. Normalizes tool name (removes "tool." prefix)
2. Checks cache for loaded tool
3. Loads from `~/.strudel/tools/{name}.ts` using jiti
4. Validates that tool exports a function
5. Caches the function for future use

**`resolveBindings(obj, stepResults): Record<string, unknown>`**:
1. Recursively scans object for string values starting with `$`
2. Calls `resolveBinding()` for each binding
3. Returns resolved object with bound values

**`resolveBinding(binding: string, stepResults: StepResult[]): unknown`**:
1. Parses `$N` or `$N.field` pattern
2. Validates step number exists
3. For `$N`: returns entire output of step N
4. For `$N.field`: navigates object path to extract specific field
5. Throws errors for invalid references

#### $N.field Binding Resolution:
The binding system works through a reference mechanism:

**Pattern**: `$<step_number>[.<field_path>]`

**Examples**:
- `$1` → Entire output of step 1
- `$2.content` → `content` field from step 2's output
- `$3.data.results` → Nested field access

**Validation Rules**:
- Step numbers must be 1-indexed and reference existing steps
- Cannot reference future steps (forward references)
- Field paths must exist in the referenced step's output
- Invalid references throw descriptive errors

### 3. Recipe Validation

**`prep(recipe: Recipe): Promise<ValidationResult>`**:
1. Checks all tools exist in `~/.strudel/tools/`
2. Validates `$N` bindings reference only previous steps
3. Ensures no duplicate step numbers
4. Returns validation errors or success

### 4. Parameter Expansion (from recipe.ts)

**`expandParams(layers, params): RecipeLayer[]`**:
1. Substitutes `{param}` tokens with provided values
2. Preserves types for exact matches (`{param}` alone)
3. Stringifies interpolated values (`text {param} text`)
4. Recursively handles nested objects and arrays

## Execution Flow

1. **Recipe Creation**: Agent creates recipe with layers and inputs
2. **Preparation**: `strudel_prep()` validates and prepares the recipe
3. **Execution**: `strudel_bake()` calls `oven.bake()`
4. **Step Processing**:
   - Load tool function
   - Resolve bindings from previous steps
   - Execute with resolved inputs
   - Store result for next steps
5. **Completion**: Return final result and all step details

## Key Design Patterns

- **Sequential Processing**: Steps execute in order, enabling dependency chains
- **Output as Input**: Each step's output becomes available to subsequent steps
- **Lazy Tool Loading**: Tools loaded on-demand and cached
- **Error Propagation**: First error stops execution with detailed context
- **Type Preservation**: Binding resolution maintains original data types
- **Workspace Persistence**: State saved after successful completion