"""Recipe-related Pydantic models for Tastelog API."""

from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from api.models.base import UTCTimestampModel


class IngredientResponse(BaseModel):
    """Single ingredient in a recipe."""

    model_config = {"extra": "forbid"}

    id: UUID
    recipe_id: UUID
    position: int = Field(ge=1)
    quantity: str | None = Field(default=None, min_length=1)
    unit: str | None = Field(default=None, min_length=1)
    name: str = Field(min_length=1)
    prep: str | None = Field(default=None, min_length=1)
    raw_text: str | None = Field(default=None, min_length=1)


class StepResponse(BaseModel):
    """Single step in a recipe."""

    model_config = {"extra": "forbid"}

    id: UUID
    recipe_id: UUID
    position: int = Field(ge=1)
    instruction: str = Field(min_length=1)
    # Issue 1 durable step-ingredient mapping, in canonical recipe
    # ingredient (position) order.
    #   None -> mapping unknown/legacy (client falls back to text matching)
    #   []   -> authoritative: this step uses no ingredients
    #   ids  -> authoritative ingredient references
    ingredient_ids: list[UUID] | None = None


class RecipeDetailResponse(UTCTimestampModel):
    """Full recipe with ingredients and steps."""

    id: UUID
    user_id: UUID
    title: str = Field(min_length=1)
    image_storage_key: str | None = Field(
        default=None,
        min_length=1,
        validation_alias="image_path",  # DB column name differs
        description="Storage key in Supabase bucket (e.g., '{user_id}/filename.jpg')",
    )
    source_url: str | None = Field(default=None)
    servings: str | None = Field(default=None, min_length=1)
    prep_time: str | None = Field(default=None, min_length=1)
    cook_time: str | None = Field(default=None, min_length=1)
    confidence_score: float | None = Field(default=None, ge=0.0, le=1.0)
    favorite: bool = False
    tags: list[str] = Field(default_factory=list)
    parent_recipe_id: UUID | None = Field(default=None)
    riff_session_id: UUID | None = Field(default=None)
    riff_label: str | None = Field(default=None, min_length=1)
    # Issue 3: monotonic content revision (CAS anchor for optimistic edits).
    content_rev: int = Field(ge=1)
    ingredients: list[IngredientResponse] = Field(default_factory=list)
    steps: list[StepResponse] = Field(default_factory=list)


class RecipeSearchResult(UTCTimestampModel):
    """Recipe summary for search results."""

    id: UUID
    title: str = Field(min_length=1)
    source_url: str | None = Field(default=None)
    servings: str | None = Field(default=None, min_length=1)
    prep_time: str | None = Field(default=None, min_length=1)
    cook_time: str | None = Field(default=None, min_length=1)
    confidence_score: float | None = Field(default=None, ge=0.0, le=1.0)
    favorite: bool = False
    tags: list[str] = Field(default_factory=list)
    parent_recipe_id: UUID | None = Field(default=None)
    riff_session_id: UUID | None = Field(default=None)
    riff_label: str | None = Field(default=None, min_length=1)


class RecipeFavoriteUpdateRequest(BaseModel):
    """Request body for updating recipe favorite status."""

    model_config = {"extra": "forbid"}

    favorite: bool


class RecipeTagsUpdateRequest(BaseModel):
    """Request body for replacing recipe tags (set semantics)."""

    model_config = {"extra": "forbid"}

    tags: list[str]


# =============================================================================
# Issue 3: explicit-operation content edit wire contract (plan section 6.1).
#
# Every model is extra="forbid" at every nesting level. Scalar patches use
# model_fields_set for tri-state semantics (absent = untouched; present
# null = intentional clear; present value = intentional change), DECLARED
# NEW MACHINERY, no prior repo precedent. Unchanged rows are never
# transmitted; a row the user never touched appears in NO update op.
#
# These validators are the Phase A layer of the binding operation
# invariants (plan section 6.8); the update_recipe_content RPC re-validates
# fail-closed as the authority. Snapshot-dependent invariants (id
# membership, order completeness against surviving rows) live in
# api.core.recipes because they need the locked pre-image.
# =============================================================================


def _reject_blank(value: str | None, field_name: str) -> None:
    """Reject whitespace-only strings (null is the only way to clear)."""
    if value is not None and not value.strip():
        raise ValueError(
            f"{field_name} cannot be blank; use null to clear"
        )


class RecipeFieldsPatch(BaseModel):
    """Tri-state patch of the editable recipe scalar fields."""

    model_config = {"extra": "forbid"}

    title: str | None = None
    servings: str | None = None
    prep_time: str | None = None
    cook_time: str | None = None

    @model_validator(mode="after")
    def _validate_patch(self) -> "RecipeFieldsPatch":
        if not self.model_fields_set:
            raise ValueError("fields patch must contain at least one key")
        if "title" in self.model_fields_set:
            if self.title is None or not self.title.strip():
                raise ValueError("title cannot be empty")
        for name in ("servings", "prep_time", "cook_time"):
            if name in self.model_fields_set:
                _reject_blank(getattr(self, name), name)
        return self


class IngredientFieldsPatch(BaseModel):
    """Tri-state patch of one ingredient row's semantic fields."""

    model_config = {"extra": "forbid"}

    name: str | None = None
    quantity: str | None = None
    unit: str | None = None
    prep: str | None = None

    @model_validator(mode="after")
    def _validate_patch(self) -> "IngredientFieldsPatch":
        if not self.model_fields_set:
            raise ValueError("update fields must contain at least one key")
        if "name" in self.model_fields_set:
            if self.name is None or not self.name.strip():
                raise ValueError("ingredient name cannot be empty")
        for field_name in ("quantity", "unit", "prep"):
            if field_name in self.model_fields_set:
                _reject_blank(getattr(self, field_name), field_name)
        return self


class IngredientUpdateOp(BaseModel):
    """Patch one existing ingredient row by stable id."""

    model_config = {"extra": "forbid"}

    id: UUID
    fields: IngredientFieldsPatch


class IngredientCreateOp(BaseModel):
    """Create one ingredient row; temp_id orders it within this request."""

    model_config = {"extra": "forbid"}

    temp_id: UUID
    name: str
    quantity: str | None = None
    unit: str | None = None
    prep: str | None = None

    @model_validator(mode="after")
    def _validate_create(self) -> "IngredientCreateOp":
        if not self.name.strip():
            raise ValueError("ingredient name cannot be empty")
        for field_name in ("quantity", "unit", "prep"):
            _reject_blank(getattr(self, field_name), field_name)
        return self


class StepFieldsPatch(BaseModel):
    """Patch one step row's instruction."""

    model_config = {"extra": "forbid"}

    instruction: str | None = None

    @model_validator(mode="after")
    def _validate_patch(self) -> "StepFieldsPatch":
        if "instruction" not in self.model_fields_set:
            raise ValueError("update fields must contain at least one key")
        if self.instruction is None or not self.instruction.strip():
            raise ValueError("step instruction cannot be empty")
        return self


class StepUpdateOp(BaseModel):
    """Patch one existing step row by stable id."""

    model_config = {"extra": "forbid"}

    id: UUID
    fields: StepFieldsPatch


class StepCreateOp(BaseModel):
    """Create one step row; temp_id orders it within this request."""

    model_config = {"extra": "forbid"}

    temp_id: UUID
    instruction: str

    @model_validator(mode="after")
    def _validate_create(self) -> "StepCreateOp":
        if not self.instruction.strip():
            raise ValueError("step instruction cannot be empty")
        return self


def _validate_section_ops(
    update: list[IngredientUpdateOp] | list[StepUpdateOp] | None,
    create: list[IngredientCreateOp] | list[StepCreateOp] | None,
    delete: list[UUID] | None,
    order: list[UUID] | None,
    fields_set: set[str],
) -> None:
    """Request-local section invariants (plan section 6.8).

    Snapshot-dependent invariants (ids belong to this recipe; order covers
    exactly the surviving + created membership) are enforced in
    api.core.recipes and re-proven by the RPC.
    """
    if not fields_set:
        raise ValueError("section must contain at least one operation")
    # `order` alone may be empty: deleting every row makes the complete
    # final membership the empty sequence. The other ops must be non-empty.
    for op_name, ops in (
        ("update", update),
        ("create", create),
        ("delete", delete),
    ):
        if op_name in fields_set and not ops:
            raise ValueError(f"{op_name} must be a non-empty list")
    if "order" in fields_set and order is None:
        raise ValueError("order must be a list")

    update_ids = [op.id for op in (update or [])]
    if len(update_ids) != len(set(update_ids)):
        raise ValueError("duplicate id across update ops")
    delete_ids = list(delete or [])
    if len(delete_ids) != len(set(delete_ids)):
        raise ValueError("duplicate id in delete ops")
    if set(update_ids) & set(delete_ids):
        raise ValueError("a row cannot be both updated and deleted")
    temp_ids = [op.temp_id for op in (create or [])]
    if len(temp_ids) != len(set(temp_ids)):
        raise ValueError("duplicate temp_id in create ops")
    if set(temp_ids) & (set(update_ids) | set(delete_ids)):
        raise ValueError("temp_id collides with an existing row id")

    if (create or delete) and order is None:
        raise ValueError("order is required when membership changes")
    if order is not None:
        if len(order) != len(set(order)):
            raise ValueError("duplicate order entry")
        missing_temp = set(temp_ids) - set(order)
        if missing_temp:
            raise ValueError("every created temp_id must appear in order")
        if set(order) & set(delete_ids):
            raise ValueError("order must not contain deleted rows")


class IngredientSectionOps(BaseModel):
    """Explicit operations on the ingredients section."""

    model_config = {"extra": "forbid"}

    update: list[IngredientUpdateOp] | None = None
    create: list[IngredientCreateOp] | None = None
    delete: list[UUID] | None = None
    order: list[UUID] | None = None

    @model_validator(mode="after")
    def _validate_section(self) -> "IngredientSectionOps":
        _validate_section_ops(
            self.update, self.create, self.delete, self.order,
            self.model_fields_set,
        )
        return self


class StepSectionOps(BaseModel):
    """Explicit operations on the steps section."""

    model_config = {"extra": "forbid"}

    update: list[StepUpdateOp] | None = None
    create: list[StepCreateOp] | None = None
    delete: list[UUID] | None = None
    order: list[UUID] | None = None

    @model_validator(mode="after")
    def _validate_section(self) -> "StepSectionOps":
        _validate_section_ops(
            self.update, self.create, self.delete, self.order,
            self.model_fields_set,
        )
        return self


class RecipeContentUpdateRequest(BaseModel):
    """Request body for PATCH /api/recipes/{recipe_id} (plan section 6.1)."""

    model_config = {"extra": "forbid"}

    # Upper bound = PostgreSQL INTEGER max: an unrepresentable revision
    # must fail request validation, never argument coercion at the RPC.
    expected_content_rev: int = Field(ge=1, le=2_147_483_647)
    mutation_id: UUID
    fields: RecipeFieldsPatch | None = None
    ingredients: IngredientSectionOps | None = None
    steps: StepSectionOps | None = None

    @model_validator(mode="after")
    def _validate_request(self) -> "RecipeContentUpdateRequest":
        # Fail closed on explicitly-null sections: a key that is PRESENT
        # must carry a real payload (absent = untouched is the only way to
        # skip a section).
        for key in ("fields", "ingredients", "steps"):
            if key in self.model_fields_set and getattr(self, key) is None:
                raise ValueError(f"{key} must not be null; omit it instead")
        if (
            self.fields is None
            and self.ingredients is None
            and self.steps is None
        ):
            raise ValueError(
                "request must contain at least one of fields, ingredients, steps"
            )
        return self
