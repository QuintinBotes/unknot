from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('shop', '0001_initial')]

    operations = [
        migrations.AddField(
            model_name='order',
            name='status',
            field=models.CharField(default='new', max_length=20),
        ),
        migrations.AlterField(
            model_name='order',
            name='total',
            field=models.BigIntegerField(default=0),
        ),
        migrations.RemoveField(model_name='order', name='note'),
        migrations.RenameField(model_name='order', old_name='status', new_name='state'),
    ]
