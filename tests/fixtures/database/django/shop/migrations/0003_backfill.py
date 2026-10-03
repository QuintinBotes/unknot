from django.db import migrations


def fill(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [('shop', '0002_order_status')]

    operations = [
        migrations.RunSQL("UPDATE shop_order SET state = 'old'"),
        migrations.RunPython(fill),
    ]
