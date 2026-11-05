from django.urls import path
from . import views

urlpatterns = [
    path('health/', views.health, name='health'),
    path('interpret-metaphor/', views.interpret_metaphor, name='interpret_metaphor'),
    path('manifest/', views.manifest, name='manifest'),
]
