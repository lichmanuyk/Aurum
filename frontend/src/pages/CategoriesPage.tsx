import { useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CategoryFormModal } from "@/components/categories/CategoryFormModal";
import { CategoryList } from "@/components/categories/CategoryList";
import { useCategories, useDeleteCategory } from "@/hooks/useCategories";
import { translateCategoryName } from "@/lib/categoryLabels";
import { useTranslation } from "@/lib/i18n";
import type { Category, CategoryKind } from "@/types";

// Alphabetical by displayed (translated) name — same locale-aware sort
// BudgetFormModal's category picker uses, so a default category shown as
// its localized name sorts by that, not its raw stored English name.
function byName(language: string) {
  return (a: Category, b: Category) =>
    translateCategoryName(a.name).localeCompare(translateCategoryName(b.name), language);
}

export function CategoriesPage() {
  const { t, language } = useTranslation();
  const { data: categories, isLoading } = useCategories();
  const deleteCategory = useDeleteCategory();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [modalKind, setModalKind] = useState<CategoryKind>("expense");

  function openCreateModal(kind: CategoryKind) {
    setEditingCategory(null);
    setModalKind(kind);
    setModalOpen(true);
  }

  function openEditModal(category: Category) {
    setEditingCategory(category);
    setModalKind(category.kind);
    setModalOpen(true);
  }

  async function handleDelete(category: Category) {
    if (!window.confirm(t("category.confirmDelete", { name: category.name }))) return;
    try {
      await deleteCategory.mutateAsync(category.id);
    } catch {
      window.alert(t("category.deleteBlocked"));
    }
  }

  const expenseCategories = (categories ?? []).filter((category) => category.kind === "expense").sort(byName(language));
  const incomeCategories = (categories ?? []).filter((category) => category.kind === "income").sort(byName(language));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>{t("category.expenseSectionTitle")}</CardTitle>
          <Button onClick={() => openCreateModal("expense")}>
            <Plus size={16} />
            {t("common.add")}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <CategoryList items={expenseCategories} onEdit={openEditModal} onDelete={handleDelete} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("category.incomeSectionTitle")}</CardTitle>
          <Button onClick={() => openCreateModal("income")}>
            <Plus size={16} />
            {t("common.add")}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <CategoryList items={incomeCategories} onEdit={openEditModal} onDelete={handleDelete} />
          )}
        </CardContent>
      </Card>

      <CategoryFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        category={editingCategory}
        defaultKind={modalKind}
      />
    </div>
  );
}
